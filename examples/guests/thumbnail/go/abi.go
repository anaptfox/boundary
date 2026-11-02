package main

import (
	"unsafe"
)

// TinyGo wasm-unknown guest: Preview 2 Canonical ABI for the JSON-string world.
// Same import and export surface as the Zig guest. No WASI.

//go:wasmimport boundary:guest/footprints@1.0.0 images
func hostImages(requestPtr, requestLen, returnArea uint32)

var (
	exportReturnArea [12]byte
	heldPayload      []byte
)

//export cabi_realloc
func cabiRealloc(ptr, oldSize, align, newSize uint32) uint32 {
	if newSize == 0 {
		if align == 0 {
			return 1
		}
		return align
	}
	buf := make([]byte, newSize)
	if ptr != 0 && oldSize != 0 {
		copy(buf, unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), min(oldSize, newSize)))
	}
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(buf))))
}

func readU32(area []byte, offset int) uint32 {
	return uint32(area[offset]) | uint32(area[offset+1])<<8 | uint32(area[offset+2])<<16 | uint32(area[offset+3])<<24
}

func writeU32(area []byte, offset int, value uint32) {
	area[offset] = byte(value)
	area[offset+1] = byte(value >> 8)
	area[offset+2] = byte(value >> 16)
	area[offset+3] = byte(value >> 24)
}

func bytesAt(ptr, length uint32) []byte {
	if length == 0 {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
}

func lookupImages(request string) (string, string, bool) {
	req := []byte(request)
	var reply [12]byte
	hostImages(
		uint32(uintptr(unsafe.Pointer(unsafe.SliceData(req)))),
		uint32(len(req)),
		uint32(uintptr(unsafe.Pointer(&reply[0]))),
	)
	payload := string(bytesAt(readU32(reply[:], 4), readU32(reply[:], 8)))
	if reply[0] == 0 {
		return payload, "", true
	}
	return "", payload, false
}

func writeExport(tag byte, payload string) uint32 {
	heldPayload = append([]byte(nil), payload...)
	exportReturnArea[0] = tag
	writeU32(exportReturnArea[:], 4, uint32(uintptr(unsafe.Pointer(unsafe.SliceData(heldPayload)))))
	writeU32(exportReturnArea[:], 8, uint32(len(heldPayload)))
	return uint32(uintptr(unsafe.Pointer(&exportReturnArea[0])))
}

//export images-make-thumbnail
func imagesMakeThumbnail(inputPtr, inputLen uint32) uint32 {
	ok, err := makeThumbnail(string(bytesAt(inputPtr, inputLen)), lookupImages)
	if err != "" {
		return writeExport(1, err)
	}
	return writeExport(0, ok)
}

//export cabi_post_images-make-thumbnail
func cabiPostImagesMakeThumbnail(_ uint32) {
	heldPayload = nil
}

func main() {}
