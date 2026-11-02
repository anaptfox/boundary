import json

from componentize_py_types import Err
from wit_world.imports import footprints


def error_payload(message: str) -> str:
    return json.dumps({"error": message})


def thumbnail_dimensions(width: float, height: float, max_width: float) -> tuple[int, int]:
    if max_width <= 0:
        raise Err(error_payload("invalid max width"))
    if width == 0 or height == 0:
        raise Err(error_payload("invalid source dimensions"))
    out_w = min(max_width, width)
    out_h = max(1, round((height * out_w) / width))
    return int(out_w), int(out_h)


class WitWorld:
    def images_make_thumbnail(self, input: str) -> str:
        parsed = json.loads(input)
        image_id = parsed.get("imageId")
        max_width = parsed.get("maxWidth")
        if not isinstance(image_id, str):
            raise Err(error_payload("imageId is required"))
        if not isinstance(max_width, (int, float)):
            raise Err(error_payload("maxWidth is required"))
        try:
            reply = footprints.images(json.dumps({"imageId": image_id}))
        except Err as error:
            payload = error.value
            if not payload:
                raise Err(error_payload("source image lookup failed")) from error
            raise
        source = json.loads(reply)
        width, height = thumbnail_dimensions(source["width"], source["height"], float(max_width))
        return json.dumps({"imageId": image_id, "width": width, "height": height})
