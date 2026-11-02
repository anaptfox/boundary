package main

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

func errorPayload(message string) string {
	return `{"error":` + strconv.Quote(message) + `}`
}

func thumbnailDimensions(width, height, maxWidth float64) (uint32, uint32, string) {
	if maxWidth <= 0 {
		return 0, 0, errorPayload("invalid max width")
	}
	if width == 0 || height == 0 {
		return 0, 0, errorPayload("invalid source dimensions")
	}
	outW := math.Min(maxWidth, width)
	outH := math.Max(1, math.Round((height*outW)/width))
	return uint32(outW), uint32(outH), ""
}

func makeThumbnail(input string, lookup func(string) (string, string, bool)) (string, string) {
	var parsed struct {
		ImageID  *string  `json:"imageId"`
		MaxWidth *float64 `json:"maxWidth"`
	}
	if err := json.Unmarshal([]byte(input), &parsed); err != nil {
		return "", errorPayload(err.Error())
	}
	if parsed.ImageID == nil {
		return "", errorPayload("imageId is required")
	}
	if parsed.MaxWidth == nil {
		return "", errorPayload("maxWidth is required")
	}
	reply, errPayload, ok := lookup(`{"imageId":` + strconv.Quote(*parsed.ImageID) + `}`)
	if !ok {
		if strings.TrimSpace(errPayload) == "" {
			return "", errorPayload("source image lookup failed")
		}
		return "", errPayload
	}
	var source struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	}
	if err := json.Unmarshal([]byte(reply), &source); err != nil {
		return "", errorPayload(err.Error())
	}
	outW, outH, fail := thumbnailDimensions(source.Width, source.Height, *parsed.MaxWidth)
	if fail != "" {
		return "", fail
	}
	return `{"imageId":` + strconv.Quote(*parsed.ImageID) + `,"width":` + strconv.FormatUint(uint64(outW), 10) + `,"height":` + strconv.FormatUint(uint64(outH), 10) + `}`, ""
}
