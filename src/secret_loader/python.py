"""框架提供的受限秘密读取 loader（Python 运行时，执行时以 sfo_secret_loader.py 上传）。"""

import os
import pathlib
import re

SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def load_secrets(*, dir, values=(), files=()):
    """按名读取值密钥（返回非空字符串）与文件密钥（返回受限绝对路径）。"""
    if not isinstance(dir, str) or not dir or "\x00" in dir or "\\" in dir:
        raise ValueError("秘密副本目录不合法")
    parts = dir.replace("\\", "/").split("/")
    if not dir.startswith("/") or ".." in parts or dir == "/":
        raise ValueError("秘密副本目录必须是安全绝对 POSIX 路径")
    value_names = [_validate_secret_name(name) for name in (values or ())]
    file_names = [_validate_secret_name(name) for name in (files or ())]
    overlap = set(value_names) & set(file_names)
    if overlap:
        raise ValueError(f"密钥 {', '.join(sorted(overlap))} 同时声明为值密钥与文件密钥")
    result_values = {}
    for name in value_names:
        path = os.path.join(dir, name)
        info = pathlib.Path(path)
        if not info.is_file() or info.is_symlink():
            raise ValueError(f"读取密钥 {name} 失败")
        content = info.read_text(encoding="utf-8")
        if not content:
            raise ValueError(f"密钥 {name} 为空")
        result_values[name] = content
    result_files = {}
    for name in file_names:
        path = os.path.join(dir, name)
        info = pathlib.Path(path)
        if not info.is_file() or info.is_symlink():
            raise ValueError(f"读取密钥 {name} 失败")
        result_files[name] = os.path.abspath(path)
    return {"values": result_values, "files": result_files}


def _validate_secret_name(name):
    if not isinstance(name, str) or not SECRET_NAME_RE.fullmatch(name):
        raise ValueError(f"密钥名不合法: {name!r}")
    return name
