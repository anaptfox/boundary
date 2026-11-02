#include "boundary.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Host-owned state; callbacks are synchronous and never reenter Boundary. */
typedef struct { unsigned admissions, effects, proposals, dispatches; int fail; } host_state;
typedef struct { int allowed; } attempt_context;
static boundary_slice slice(const char *s) { return (boundary_slice){(const uint8_t *)s, strlen(s)}; }
static boundary_slice bytes(boundary_buffer b) { return (boundary_slice){b.ptr, b.len}; }
static int includes(boundary_buffer b, const char *needle) {
  size_t n = strlen(needle);
  if (n > b.len) return 0;
  for (size_t i = 0; i <= b.len - n; ++i) if (memcmp(b.ptr + i, needle, n) == 0) return 1;
  return 0;
}
/* Find the root manifest's interactions array, ignoring identically named
 * fields inside its embedded Programs and catalog. Input comes from Boundary. */
static boundary_buffer selected_entries(boundary_buffer json) {
  const char key[] = "\"interactions\":[";
  size_t depth = 0; int string = 0, escaped = 0;
  for (size_t i = 0; i < json.len; ++i) {
    uint8_t c = json.ptr[i];
    if (!string && depth == 1 && i + sizeof key - 1 <= json.len && memcmp(json.ptr + i, key, sizeof key - 1) == 0) {
      size_t start = i + sizeof key - 2, nested = 0; int quoted = 0, slash = 0;
      for (size_t j = start; j < json.len; ++j) {
        uint8_t item = json.ptr[j];
        if (quoted) { if (slash) slash = 0; else if (item == '\\') slash = 1; else if (item == '"') quoted = 0; continue; }
        if (item == '"') quoted = 1;
        else if (item == '[') ++nested;
        else if (item == ']' && --nested == 0) return (boundary_buffer){json.ptr + start, j - start + 1};
      }
      break;
    }
    if (string) { if (escaped) escaped = 0; else if (c == '\\') escaped = 1; else if (c == '"') string = 0; continue; }
    if (c == '"') string = 1;
    else if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') { assert(depth > 0); --depth; }
  }
  return (boundary_buffer){NULL, 0};
}
static int32_t admit(void *user, void *context, boundary_slice id, uint32_t mode, boundary_slice input) {
  host_state *s = user;
  attempt_context *attempt = context;
  (void)id; (void)mode; (void)input;
  ++s->admissions;
  return attempt != NULL && attempt->allowed ? 1 : 0;
}
static int32_t dispatch(void *user, void *context, boundary_slice id, uint32_t mode, boundary_slice input, boundary_slice *reply) {
  host_state *s = user;
  (void)context; (void)id; (void)input;
  ++s->dispatches;
  if (s->fail == 1) return 1;
  if (s->fail == 4) { ++s->effects; return 1; }
  if (s->fail == 2) { *reply = slice("{\"kind\":\"declared-error\",\"code\":\"rejected\",\"details\":\"explanation\"}"); return 0; }
  if (s->fail == 3) { *reply = slice("{invalid"); return 0; }
  if (mode == BOUNDARY_MODE_REQUEST) {
    ++s->proposals;
    *reply = slice("{\"kind\":\"proposed\",\"proposal\":\"draft\"}");
  } else {
    ++s->effects;
    *reply = slice("{\"kind\":\"returned\",\"value\":{\"id\":\"1\",\"title\":\"hello\"}}");
  }
  return 0;
}
static boundary_interaction todo(void) {
  boundary_interaction d = {0};
  d.struct_size = sizeof d;
  d.id = slice("todos.create"); d.alias = slice("create");
  d.input_schema = slice("{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\",\"minLength\":1}},\"required\":[\"title\"],\"additionalProperties\":false}");
  d.output_schema = slice("{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"}},\"required\":[\"id\",\"title\"],\"additionalProperties\":false}");
  d.reads = slice("[\"todos\"]"); d.changes = slice("[\"todos\"]");
  d.input_arity = 1; d.modes = BOUNDARY_MODE_DIRECT | BOUNDARY_MODE_REQUEST;
  d.direct_realization_id = slice("fixture:direct"); d.request_realization_id = slice("fixture:request");
  d.request_control_digest = slice("sha256:4444444444444444444444444444444444444444444444444444444444444444");
  d.request_preview_schema = slice("{\"type\":\"string\"}");
  return d;
}
static boundary_buffer make_call(boundary_binding *binding, uint32_t mode, const char *input) {
  boundary_buffer invocation = {0};
  assert(boundary_binding_invocation(binding, slice("todos.create"), mode, slice(input), &invocation) == BOUNDARY_OK);
  assert(invocation.ptr != NULL && invocation.len > 0);
  return invocation;
}
static boundary_buffer call(boundary_binding *binding, boundary_buffer invocation, attempt_context *ctx) {
  boundary_buffer outcome = {0};
  int32_t status = boundary_binding_invoke(binding, bytes(invocation), ctx, &outcome);
  if (status != BOUNDARY_OK) fprintf(stderr, "invoke status %d\n", (int)status);
  assert(status == BOUNDARY_OK);
  assert(outcome.ptr != NULL && outcome.len > 0);
  return outcome;
}
static void round_trip(void) {
  host_state state = {0}; attempt_context allow = {1}, deny = {0};
  boundary_host *host = NULL; boundary_binding *binding = NULL, *second = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, admit, dispatch};
  boundary_interaction d = todo();
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:installation"), &callbacks, &host) == BOUNDARY_OK);
  assert(host != NULL);
  assert(boundary_host_add(host, &d) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &second) == BOUNDARY_OK);
  boundary_buffer manifest = {0};
  assert(boundary_binding_manifest(binding, &manifest) == BOUNDARY_OK);
  assert(includes(manifest, "todos.create"));
  assert(includes(manifest, "sha256:d37c59dc376922352109edc2b1d06c153e8060d31c302d40f553255cec62fe8b"));
  assert(includes(manifest, "sha256:af8a13a5d14c9ce46f716572f0d55c7fb2aae01048b14231366dac98589d8fa3"));
  boundary_buffer_free(manifest);
  boundary_buffer inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  boundary_buffer stale = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  const char *original = "fixture:direct", *replacement = "fixture:stale_";
  size_t length = strlen(original), position = stale.len;
  for (size_t i = 0; i + length <= stale.len; ++i) {
    if (memcmp(stale.ptr + i, original, length) == 0) { position = i; break; }
  }
  assert(position < stale.len && length == strlen(replacement));
  memcpy(stale.ptr + position, replacement, length);
  boundary_buffer rejected = {0};
  assert(boundary_binding_invoke(binding, bytes(stale), &allow, &rejected) == BOUNDARY_INVALID_DATA);
  assert(state.dispatches == 0 && state.admissions == 0);
  boundary_buffer_free(stale);
  boundary_buffer invalid = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":12}");
  boundary_buffer invalid_out = call(binding, invalid, &allow);
  assert(includes(invalid_out, "not-started") && state.dispatches == 0 && state.admissions == 0);
  boundary_buffer_free(invalid_out); boundary_buffer_free(invalid);
  boundary_buffer malformed = {0};
  assert(boundary_binding_invocation(binding, slice("todos.create"), BOUNDARY_MODE_DIRECT, slice("{"), &malformed) == BOUNDARY_INVALID_DATA);
  assert(boundary_binding_invocation(binding, slice("todos.create"), BOUNDARY_MODE_DIRECT, slice("{}"), NULL) == BOUNDARY_INVALID_ARGUMENT);
  assert(state.dispatches == 0 && state.admissions == 0);
  boundary_buffer out = call(binding, inv, &deny);
  assert(includes(out, "not-started") && includes(out, "denied") && state.effects == 0);
  boundary_buffer_free(out);
  out = call(binding, inv, &allow);
  assert(includes(out, "completed") && includes(out, "returned") && state.effects == 1);
  boundary_buffer_free(out); boundary_buffer_free(inv);
  inv = make_call(binding, BOUNDARY_MODE_REQUEST, "{\"title\":\"hello\"}");
  out = call(binding, inv, &allow);
  assert(includes(out, "proposed") && state.proposals == 1 && state.effects == 1);
  boundary_buffer_free(out);
  state.fail = 1; unsigned request_before = state.dispatches;
  out = call(binding, inv, &allow);
  assert(includes(out, "not-started") && state.dispatches == request_before + 1 && state.effects == 1);
  boundary_buffer_free(out); boundary_buffer_free(inv);
  state.fail = 1; inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  unsigned before = state.dispatches;
  out = call(binding, inv, &allow);
  assert(includes(out, "unknown") && state.dispatches == before + 1 && state.effects == 1);
  boundary_buffer_free(out); state.fail = 3; before = state.dispatches;
  out = call(binding, inv, &allow);
  assert(includes(out, "unknown") && state.dispatches == before + 1 && state.effects == 1);
  boundary_buffer_free(out); boundary_buffer_free(inv); state.fail = 0;
  assert(boundary_binding_revoke(binding) == BOUNDARY_OK);
  inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  out = call(binding, inv, &allow);
  assert(includes(out, "revoked") && includes(out, "not-started") && state.effects == 1);
  boundary_buffer_free(out); boundary_buffer_free(inv);
  inv = make_call(second, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  out = call(second, inv, &allow);
  assert(includes(out, "completed") && state.effects == 2);
  boundary_buffer_free(out); boundary_buffer_free(inv);
  boundary_binding_destroy(second); boundary_binding_destroy(binding); boundary_host_destroy(host);
}
static void missing_admission_denies(void) {
  host_state state = {0}; attempt_context allow = {1}; boundary_host *host = NULL; boundary_binding *binding = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, NULL, dispatch}; boundary_interaction d = todo();
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:no-admission"), &callbacks, &host) == BOUNDARY_OK);
  assert(boundary_host_add(host, &d) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  boundary_buffer inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  boundary_buffer out = call(binding, inv, &allow);
  assert(includes(out, "not-started") && includes(out, "denied") && state.dispatches == 0);
  boundary_buffer_free(out); boundary_buffer_free(inv); boundary_binding_destroy(binding); boundary_host_destroy(host);
}
/* A host effect can happen before its callback loses the response. */
static void lost_response_after_effect(void) {
  host_state state = {0}; attempt_context allow = {1}; boundary_host *host = NULL; boundary_binding *binding = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, admit, dispatch}; boundary_interaction d = todo();
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:lost-response"), &callbacks, &host) == BOUNDARY_OK);
  assert(boundary_host_add(host, &d) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  state.fail = 4;
  boundary_buffer inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  boundary_buffer out = call(binding, inv, &allow);
  assert(includes(out, "unknown") && state.effects == 1 && state.dispatches == 1);
  boundary_buffer_free(out); boundary_buffer_free(inv);
  boundary_binding_destroy(binding); boundary_host_destroy(host);
  assert(state.effects == 1 && state.dispatches == 1);
}
static void zero_arity(void) {
  host_state state = {0}; attempt_context allow = {1}; boundary_host *host = NULL; boundary_binding *binding = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, admit, dispatch}; boundary_interaction d = todo();
  d.input_arity = 0; d.input_schema = slice("{\"type\":\"object\"}"); d.modes = BOUNDARY_MODE_DIRECT;
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:zero"), &callbacks, &host) == BOUNDARY_OK);
  assert(boundary_host_add(host, &d) == BOUNDARY_INVALID_DATA);
  d.input_schema = slice("{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":false}");
  assert(boundary_host_add(host, &d) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  boundary_buffer inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"not empty\"}");
  boundary_buffer out = call(binding, inv, &allow);
  assert(includes(out, "not-started") && state.admissions == 0 && state.dispatches == 0);
  boundary_buffer_free(out); boundary_buffer_free(inv); boundary_binding_destroy(binding); boundary_host_destroy(host);
}
static void declared_error(void) {
  host_state state = {0}; attempt_context allow = {1}; boundary_host *host = NULL; boundary_binding *binding = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, admit, dispatch}; boundary_interaction d = todo();
  d.error_schema = slice("{\"type\":\"object\",\"properties\":{\"code\":{\"const\":\"rejected\"},\"details\":{\"type\":\"string\"}},\"required\":[\"code\",\"details\"],\"additionalProperties\":false}");
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:error"), &callbacks, &host) == BOUNDARY_OK);
  assert(boundary_host_add(host, &d) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  state.fail = 2;
  boundary_buffer inv = make_call(binding, BOUNDARY_MODE_DIRECT, "{\"title\":\"hello\"}");
  boundary_buffer out = call(binding, inv, &allow);
  assert(includes(out, "completed") && includes(out, "declared-error") && includes(out, "explanation") && state.effects == 0);
  boundary_buffer_free(out); boundary_buffer_free(inv); boundary_binding_destroy(binding); boundary_host_destroy(host);
}
static void unselected(void) {
  host_state state = {0}; boundary_host *host = NULL; boundary_binding *binding = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, &state, admit, dispatch};
  boundary_interaction selected = todo(), hidden = todo();
  hidden.id = slice("todos.hidden"); hidden.alias = slice("hidden"); hidden.modes = 0;
  hidden.direct_realization_id = (boundary_slice){NULL, 0};
  hidden.request_realization_id = (boundary_slice){NULL, 0};
  hidden.request_control_digest = (boundary_slice){NULL, 0};
  hidden.request_preview_schema = (boundary_slice){NULL, 0};
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("fixture:selection"), &callbacks, &host) == BOUNDARY_OK);
  boundary_interaction short_struct = selected; short_struct.struct_size = 0;
  assert(boundary_host_add(host, &short_struct) == BOUNDARY_INVALID_ARGUMENT);
  assert(boundary_host_add(host, &selected) == BOUNDARY_OK);
  assert(boundary_host_add(host, &hidden) == BOUNDARY_OK);
  assert(boundary_host_bind(host, &binding) == BOUNDARY_OK);
  boundary_buffer manifest = {0};
  assert(boundary_binding_manifest(binding, &manifest) == BOUNDARY_OK);
  boundary_buffer entries = selected_entries(manifest);
  assert(entries.ptr != NULL && includes(entries, "todos.create") && !includes(entries, "todos.hidden"));
  boundary_buffer_free(manifest);
  boundary_buffer invocation = {0};
  assert(boundary_binding_invocation(binding, slice("todos.hidden"), BOUNDARY_MODE_DIRECT, slice("{}"), &invocation) == BOUNDARY_INVALID_DATA);
  assert(state.admissions == 0 && state.dispatches == 0);
  boundary_binding_destroy(binding); boundary_host_destroy(host);
}
int main(void) {
  assert(boundary_abi_version() == BOUNDARY_ABI_VERSION);
  assert((boundary_capabilities() & (BOUNDARY_CAP_DIRECT | BOUNDARY_CAP_REQUEST)) == (BOUNDARY_CAP_DIRECT | BOUNDARY_CAP_REQUEST));
  boundary_host *host = NULL;
  boundary_callbacks callbacks = {sizeof callbacks, NULL, NULL, NULL};
  assert(boundary_host_create(BOUNDARY_ABI_VERSION + 1, slice("bad"), &callbacks, &host) != BOUNDARY_OK);
  assert(host == NULL);
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, (boundary_slice){NULL, 1}, &callbacks, &host) != BOUNDARY_OK);
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("bad"), &callbacks, NULL) != BOUNDARY_OK);
  boundary_callbacks short_callbacks = callbacks; short_callbacks.struct_size = 0;
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, slice("bad"), &short_callbacks, &host) == BOUNDARY_INVALID_ARGUMENT);
  const uint8_t invalid_utf8[] = {0xff};
  assert(boundary_host_create(BOUNDARY_ABI_VERSION, (boundary_slice){invalid_utf8, sizeof invalid_utf8}, &callbacks, &host) != BOUNDARY_OK);
  unselected();
  declared_error();
  missing_admission_denies();
  lost_response_after_effect();
  zero_arity();
  for (unsigned i = 0; i < 32; ++i) round_trip();
  puts("C host: selected binding, exact reviewed identities, admission, direct/request, unknown and revocation passed");
  return 0;
}
