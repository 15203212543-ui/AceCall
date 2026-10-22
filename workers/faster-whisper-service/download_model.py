"""构建期预下载 faster-whisper 权重。

为什么不用 huggingface_hub 的 download_model：
新版 hf_hub 会把大文件重定向到 xet 存储（cas-server.xethub.hf.co），
在构建容器里常因缺少授权返回

    401 Unauthorized → File reconstruction error: CAS Client Error

导致镜像构建直接失败。直接走 HTTP 拉 resolve/main 下的几个固定文件，
行为稳定、错误信息清楚，也不依赖 hf_hub 的版本行为。

用法（在 Dockerfile 里）：
    python download_model.py <模型名> <目标目录>
    python download_model.py tiny /models/tiny
"""
import os
import sys
import urllib.error
import urllib.request

# faster-whisper 的 CTranslate2 权重仓库，文件名固定
FILES = ("config.json", "tokenizer.json", "vocabulary.txt", "model.bin")

# hf-mirror 会拒绝默认的 Python-urllib UA（实测返回 403），
# 必须显式带上常见的浏览器/工具 UA。
USER_AGENT = "acecall-asr-build/1.0 (+https://github.com/15203212543-ui/AceCall)"


def open_url(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(request, timeout=120)


def repo_for(model):
    """模型名 → HuggingFace 仓库。已是本地路径时返回空串。"""
    if model.startswith("/") or model.startswith("./"):
        return ""
    if model.startswith("Systran/"):
        return model
    return f"Systran/faster-whisper-{model}"


def download(model, target, endpoint):
    repo = repo_for(model)
    if not repo:
        print(f"本地路径模式，跳过预下载：{model}")
        return
    base = f"{endpoint.rstrip('/')}/{repo}/resolve/main"
    os.makedirs(target, exist_ok=True)
    for name in FILES:
        url = f"{base}/{name}?download=true"
        path = os.path.join(target, name)
        # 已存在且非空就跳过，方便本地反复构建
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print(f"已存在，跳过 {path}")
            continue
        print(f"下载 {url}", flush=True)
        try:
            with open_url(url) as response, open(path, "wb") as sink:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    sink.write(chunk)
        except urllib.error.HTTPError as error:
            # preprocessor_config.json 之类可选文件在各仓库里时有时无，
            # 但这里列出的四个是必需的，缺任何一个都无法加载
            raise SystemExit(f"下载失败 {url}：HTTP {error.code}") from error
        print(f"  → {path}  {os.path.getsize(path)} 字节", flush=True)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("用法: python download_model.py <模型名> <目标目录>")
    model, target = sys.argv[1], sys.argv[2]
    endpoint = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")
    print(f"模型={model} 目标={target} 源={endpoint}")
    download(model, target, endpoint)


if __name__ == "__main__":
    main()
