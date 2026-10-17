"""Identity QA gate: keep only renders whose face matches the R0 anchor.

Needs `pip install insightface onnxruntime-gpu opencv-python` (optional - without it the gate is
skipped and the first render is used).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

MIN_SIMILARITY = 0.60


@lru_cache(maxsize=1)
def _app():
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def _embedding(path: Path):
    import cv2

    faces = _app().get(cv2.imread(str(path)))
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding


def similarity(candidate: Path, anchor: Path) -> float:
    a, b = _embedding(candidate), _embedding(anchor)
    if a is None or b is None:
        return 0.0
    return float((a * b).sum())


def best_match(candidates: list[Path], anchor: Path) -> tuple[Path, float]:
    """Highest-similarity render. Raises if none clears MIN_SIMILARITY (re-roll or send to a human)."""
    try:
        scored = sorted(((similarity(c, anchor), c) for c in candidates), reverse=True)
    except ImportError:
        return candidates[0], float("nan")
    score, path = scored[0]
    if score < MIN_SIMILARITY:
        raise ValueError(f"face drift: best similarity {score:.2f} < {MIN_SIMILARITY}")
    return path, score
