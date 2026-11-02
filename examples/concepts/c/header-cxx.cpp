#include "boundary.h"
#include <cassert>
int main() {
  assert(boundary_abi_version() == BOUNDARY_ABI_VERSION);
  return 0;
}
