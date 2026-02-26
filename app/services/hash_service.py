import hashlib
import asyncio


async def compute_sha256(filepath: str) -> str:
    return await asyncio.to_thread(_compute_hash, filepath, "sha256")


async def compute_sha512(filepath: str) -> str:
    return await asyncio.to_thread(_compute_hash, filepath, "sha512")


async def compute_md5(filepath: str) -> str:
    return await asyncio.to_thread(_compute_hash, filepath, "md5")


def _compute_hash(filepath: str, algorithm: str) -> str:
    h = hashlib.new(algorithm)
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


async def verify_checksum(filepath: str, expected: str, hash_type: str) -> bool:
    hash_type = hash_type.lower()
    if hash_type == "sha256":
        actual = await compute_sha256(filepath)
    elif hash_type == "sha512":
        actual = await compute_sha512(filepath)
    elif hash_type == "md5":
        actual = await compute_md5(filepath)
    else:
        return False
    return actual.lower() == expected.lower()
