#ifndef BOUNDARY_H
#define BOUNDARY_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && !defined(BOUNDARY_STATIC)
# if defined(BOUNDARY_BUILD)
#  define BOUNDARY_API __declspec(dllexport)
# else
#  define BOUNDARY_API __declspec(dllimport)
# endif
#elif defined(__GNUC__) && !defined(BOUNDARY_STATIC)
# define BOUNDARY_API __attribute__((visibility("default")))
#else
# define BOUNDARY_API
#endif

#define BOUNDARY_ABI_VERSION 1u
#define BOUNDARY_MAX_SLICE_BYTES (16u * 1024u * 1024u)
#define BOUNDARY_CAP_DIRECT 1u
#define BOUNDARY_CAP_REQUEST 2u
#define BOUNDARY_MODE_DIRECT 1u
#define BOUNDARY_MODE_REQUEST 2u
#define BOUNDARY_OK 0
#define BOUNDARY_INVALID_ARGUMENT 1
#define BOUNDARY_INVALID_DATA 2
#define BOUNDARY_UNREALIZED 3
#define BOUNDARY_INTERNAL_ERROR 4

typedef struct boundary_host boundary_host;
typedef struct boundary_binding boundary_binding;
typedef struct { const uint8_t *ptr; size_t len; } boundary_slice;
typedef struct { uint8_t *ptr; size_t len; } boundary_buffer;

/* UTF-8 slices are borrowed; schemas and footprints are JSON values. The host
 * supplies portable schema objects, not generated Program identities. modes is
 * a bitset (zero retains the declaration without selecting it); zero input
 * arity requires the canonical empty-object schema with type object, empty
 * properties and required arrays, and additionalProperties false. error_schema,
 * when present, describes the complete declared error value {"code":...,
 * "details":...}, as in every Boundary contract. Realization IDs and request identity are required for each mode. */
typedef struct {
  size_t struct_size; /* set to sizeof(boundary_interaction) */
  boundary_slice id, alias, input_schema, output_schema, error_schema;
  boundary_slice reads, changes;
  uint32_t input_arity, modes;
  boundary_slice direct_realization_id, request_realization_id;
  boundary_slice request_control_digest, request_preview_schema;
} boundary_interaction;

/* Invoked synchronously once per attempt. Callback interaction_id and input_json
 * slices are valid only during that callback; copy them to retain their data.
 * `context` is supplied to invoke,
 * not retained. admit returns 1 to allow, anything else denies. dispatch
 * writes a UTF-8 JSON reply borrowed from host memory until invoke returns:
 * direct: {"kind":"returned","value":...}, {"kind":"declared-error",
 * "code":"...","details":...}, or {"kind":"denied","code":"..."};
 * request: {"kind":"proposed","proposal":...} or denied. Nonzero callback
 * status or invalid reply after direct dispatch is unknown. For request mode
 * failure is request-failed/not-started for the interaction effect; this does
 * not prove no proposal record was created. Never retry automatically. */
typedef int32_t (*boundary_admit_fn)(void *userdata, void *context, boundary_slice interaction_id, uint32_t mode, boundary_slice input_json);
typedef int32_t (*boundary_dispatch_fn)(void *userdata, void *context, boundary_slice interaction_id, uint32_t mode, boundary_slice input_json, boundary_slice *reply_json);
typedef struct { size_t struct_size; void *userdata; boundary_admit_fn admit; boundary_dispatch_fn dispatch; } boundary_callbacks;

/* All handles are host-owned, thread-confined, and non-reentrant. Do not call
 * into Boundary from callbacks, destroy/revoke during a call, use stale handles,
 * or concurrently access a handle. Non-null pointers must designate valid memory
 * for their stated length; each slice is limited to BOUNDARY_MAX_SLICE_BYTES.
 * Zero-length slices may use NULL. No foreign longjmp
 * or exception may cross a callback. Dispose bindings before their host.
 * Callback userdata must remain valid until every binding is destroyed. An
 * INTERNAL_ERROR from invoke does not establish whether an effect started;
 * reconcile before retrying. Set struct_size on each input struct; current v1
 * requires at least sizeof the corresponding struct.
 * Every returned buffer belongs to Boundary and must be freed exactly once with
 * boundary_buffer_free; no function frees caller-owned input/callback data.
 * Errors are API status codes, not interaction outcomes. Stale pins and
 * unselected modes return INVALID_DATA with no callback; invalid input at invoke
 * yields a checked not-started fault outcome. Invocation construction pins the
 * selected mode and does not itself dispatch. */
BOUNDARY_API uint32_t boundary_abi_version(void);
BOUNDARY_API uint64_t boundary_capabilities(void);
BOUNDARY_API int32_t boundary_host_create(uint32_t version, boundary_slice installation_id, const boundary_callbacks *callbacks, boundary_host **out);
BOUNDARY_API int32_t boundary_host_add(boundary_host *host, const boundary_interaction *interaction);
BOUNDARY_API int32_t boundary_host_bind(boundary_host *host, boundary_binding **out);
BOUNDARY_API int32_t boundary_binding_manifest(boundary_binding *binding, boundary_buffer *out);
BOUNDARY_API int32_t boundary_binding_invocation(boundary_binding *binding, boundary_slice interaction_id, uint32_t mode, boundary_slice input_json, boundary_buffer *out);
BOUNDARY_API int32_t boundary_binding_invoke(boundary_binding *binding, boundary_slice invocation_json, void *context, boundary_buffer *out);
BOUNDARY_API int32_t boundary_binding_revoke(boundary_binding *binding);
BOUNDARY_API void boundary_binding_destroy(boundary_binding *binding);
BOUNDARY_API void boundary_host_destroy(boundary_host *host);
BOUNDARY_API void boundary_buffer_free(boundary_buffer buffer);
#ifdef __cplusplus
}
#endif
#endif
