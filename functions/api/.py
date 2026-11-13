cd ~/ffmpeg-worker
source venv/bin/activate
nano ~/ffmpeg-worker/main.py
cat ~/ffmpeg-worker/main.py

rm -rf ~/ffmpeg-worker/main.py
ls -lh ~/ffmpeg-worker/

sudo systemctl daemon-reload
sudo systemctl restart oracle-video
sudo systemctl status oracle-video --no-pager
sudo journalctl -u oracle-video -f

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from typing import Optional
import os, io, time, shutil, subprocess, requests, boto3, mimetypes
from requests_toolbelt import MultipartEncoder
from botocore.config import Config
from pathlib import Path
from dotenv import load_dotenv
from botocore.exceptions import ClientError
from fastapi import BackgroundTasks
from concurrent.futures import ThreadPoolExecutor
from fastapi.responses import StreamingResponse, FileResponse, Response
from fastapi import Request
from pathlib import Path
from email.utils import formatdate, parsedate_to_datetime
from urllib.parse import quote
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()
KARAKEEP_TOKEN = os.getenv("KARAKEEP_TOKEN", "")
required_env = ["PROCESS_SECRET", "UPDATE_STATUS_URL", "ORACLE_SECRET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MY_BUCKET", "TG_LOCAL_API", "TG_BOT_TOKEN", "TG_CHAT_ID"]
for key in required_env:
    if not os.getenv(key): raise RuntimeError(f"缺少环境变量: {key}")
PROCESS_SECRET = os.getenv("PROCESS_SECRET"); UPDATE_STATUS_URL = os.getenv("UPDATE_STATUS_URL"); ORACLE_SECRET = os.getenv("ORACLE_SECRET")
R2_ENDPOINT = os.getenv("R2_ENDPOINT"); R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID"); R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
MY_BUCKET = os.getenv("MY_BUCKET"); TG_LOCAL_API = os.getenv("TG_LOCAL_API"); TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN"); TG_CHAT_ID = os.getenv("TG_CHAT_ID"); TG_LOCAL_ROOT = os.getenv("TG_LOCAL_ROOT","/data/telegram-bot-api")
TG_ROOT = Path(TG_LOCAL_ROOT).resolve()
def mask_token(s):
    if s is None:
        return s
    if not isinstance(s, str):
        s = str(s)
    return s.replace(TG_BOT_TOKEN, "<TOKEN>")

s3 = boto3.client("s3", endpoint_url=R2_ENDPOINT, aws_access_key_id=R2_ACCESS_KEY_ID, aws_secret_access_key=R2_SECRET_ACCESS_KEY, config=Config(connect_timeout=10, read_timeout=3600,retries={"max_attempts":3}))
app = FastAPI()
# 🌟 允许特定的前端域名跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://bookmarks.mcck.ccwu.cc",
        "https://kklink.pages.dev"
    ], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

migration_lock = set()
class TelegramUploadedException(Exception):
    """
    Telegram已经成功接收文件，
    但是后续解析、getFile、同步等步骤失败。
    这种情况禁止重新上传。
    """
    pass

class ProcessRequest(BaseModel):
    shortId: str; fileKey: str; fileName: str; fileType: str; fileSize: int; fileUrl: str; folderPath: Optional[str] = None

@app.get("/")
def home(): return {"status": "ok", "service": "ffmpeg-worker"}

def update_status(shortId, status):
    try:
        print(f"更新状态 {shortId} => {status}")
        r = requests.post(UPDATE_STATUS_URL, headers={"Content-Type": "application/json", "X-Oracle-Secret": ORACLE_SECRET}, json={"shortId": shortId, "status": status}, timeout=15)
        print("状态返回:", r.text)
    except Exception as e: print("更新状态失败:", e)

def update_tg_info(shortId, result):
    try:
        print(f"更新TG信息 {shortId}")
        r = requests.post(UPDATE_STATUS_URL, headers={"Content-Type":"application/json","X-Oracle-Secret":ORACLE_SECRET}, json={"shortId":shortId,"status":"TG_UPLOADED","source":"R2","r2_deleted":"0","tg":result}, timeout=15)
        print("TG信息返回:", r.text)
    except Exception as e:
        print("更新TG信息失败:",e)
        raise

def update_tg_info_safe(shortId, result):
    try:
        print(f"提交TG完成状态 {shortId}")
        payload = {"shortId":shortId,"status":"TG_UPLOADED","source":"R2","r2_deleted":"0","tg":result}
        r = requests.post(UPDATE_STATUS_URL, headers={"Content-Type":"application/json","X-Oracle-Secret":ORACLE_SECRET}, json=payload, timeout=15)
        print("TG状态提交返回:", r.text)
        if r.status_code < 200 or r.status_code >= 300: raise Exception(f"Oracle返回异常:{r.status_code}")
        return True
    except Exception as e:
        print("TG已经上传成功，但是状态保存失败:", repr(e))
        return False

def download_file(fileKey, target):
    print("开始下载R2:", fileKey); start = time.time()
    try: s3.download_file(MY_BUCKET, fileKey, target)
    except Exception as e: print("R2下载失败:", e); raise
    size = os.path.getsize(target); cost = time.time() - start
    print(f"下载完成 {size/1024/1024:.2f}MB 耗时 {cost:.2f}s")

def is_video(file_type, filename):
    if file_type.startswith("video/"): return True
    ext = Path(filename).suffix.lower()
    return ext in [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".wmv", ".flv", ".rm", ".rmvb", ".ogv", ".asf", ".webm", ".mpeg", ".mpg", ".3gp", ".f4v"]

# ⭐ 新增：判断是否图片
def is_image(file_type, filename):
    if file_type.startswith("image/"): return True
    ext = Path(filename).suffix.lower()
    return ext in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".jfif", ".heic", ".heif"]

def need_encode(filename):
    ext = Path(filename).suffix.lower()
    return ext in [".mkv", ".avi", ".wmv", ".flv", ".rm", ".rmvb", ".ogv", ".asf", ".webm", ".mpeg", ".mpg"]

def run_ffmpeg(input_file, output_file, encode=False):
    print("开始FFmpeg处理"); start = time.time()
    if encode:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-i", input_file, "-map_metadata", "0", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output_file]
    else:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-i", input_file, "-map_metadata", "0", "-c", "copy", "-movflags", "+faststart", output_file]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=3600)
    if result.returncode != 0: print(result.stdout); raise Exception("FFmpeg失败")
    if not os.path.exists(output_file): raise Exception("FFmpeg没有生成输出文件")
    if os.path.getsize(output_file) == 0: raise Exception("FFmpeg输出为空")
    size = os.path.getsize(output_file); cost = time.time() - start
    print(f"FFmpeg完成 {size/1024/1024:.2f}MB 耗时 {cost:.2f}s")

def generate_thumbnail(input_file, output_file):
    print("开始生成缩略图"); start = time.time()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-ss", "00:00:01", "-i", input_file, "-frames:v", "1", "-q:v", "2", output_file, "-y"]
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
    except subprocess.TimeoutExpired: raise Exception("缩略图生成超时（超过60秒）")
    if result.returncode != 0: print(result.stdout); raise Exception("缩略图生成失败")
    if not os.path.exists(output_file): raise Exception("缩略图没有生成")
    if os.path.getsize(output_file) == 0: raise Exception("缩略图文件为空")
    size = os.path.getsize(output_file); cost = time.time() - start
    print(f"缩略图完成 {size/1024:.2f}KB 耗时 {cost:.2f}s")

# ⭐ 新增：图片压缩（最长边缩到 max_size 内，q:v 越小质量越高）
def compress_image(input_file, output_file, max_size=1280, quality=3):
    print("开始压缩图片"); start = time.time()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-i", input_file, "-vf", f"scale='min({max_size},iw)':-1", "-q:v", str(quality), output_file]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
    if result.returncode != 0: print(result.stdout); raise Exception("FFmpeg压缩图片失败")
    if not os.path.exists(output_file): raise Exception("压缩图片未生成")
    if os.path.getsize(output_file) == 0: raise Exception("压缩图片为空")
    size = os.path.getsize(output_file); cost = time.time() - start
    print(f"压缩完成 {size/1024:.2f}KB 耗时 {cost:.2f}s")

def upload_to_telegram(file_path, upload_name=None):
    if not os.path.exists(file_path):
        raise Exception(f"上传文件不存在:{file_path}")
    if os.path.getsize(file_path) == 0:
        raise Exception(f"上传文件为空:{file_path}")
    filename = upload_name if upload_name else os.path.basename(file_path)
    mime_type, _ = mimetypes.guess_type(filename)
    if not mime_type: mime_type = "application/octet-stream"
    print(f"Telegram上传类型: {filename} => {mime_type}")
    url = f"{TG_LOCAL_API}/bot{TG_BOT_TOKEN}/sendDocument"
    size = os.path.getsize(file_path)
    max_retry = 3
    for attempt in range(1, max_retry + 1):
        print(f"开始上传Telegram 第 {attempt}/{max_retry} 次:", file_path)
        start = time.time()
        telegram_received = False
        try:
            with open(file_path, "rb") as f:
                encoder = MultipartEncoder(fields={"chat_id": TG_CHAT_ID,"document": (filename, f, mime_type)})
                r = requests.post(url, data=encoder, headers={"Content-Type": encoder.content_type, "Content-Length": str(encoder.len)}, timeout=(30,21600))
            if r.status_code == 429:
                retry_after = 5
                try:
                    err_data = r.json(); retry_after = err_data.get("parameters", {}).get("retry_after", 5)
                except Exception: pass
                print(f"⚠️ Telegram 限流 429，等待 {retry_after} 秒后重试 (第 {attempt}/{max_retry} 次)")
                if attempt < max_retry:
                    time.sleep(retry_after + 1); continue
                else:
                    raise Exception(f"Telegram 限流，重试 {max_retry} 次后仍失败 (retry_after={retry_after})")
            if r.status_code != 200: raise Exception(f"Telegram HTTP错误:{r.status_code}")
            try: result = r.json()
            except Exception: raise Exception(f"Telegram返回非JSON:{r.text[:500]}")
            if not result.get("ok"): raise Exception(f"Telegram返回失败:{result}")
            telegram_received = True
            msg = result.get("result")
            if not msg: raise Exception("Telegram成功，但是result不存在")
            file_obj = msg.get("document") or msg.get("video") or msg.get("animation") or msg.get("audio")
            if not file_obj: raise Exception(f"Telegram成功，但是文件字段不存在:{msg.keys()}")
            file_id = file_obj.get("file_id")
            if not file_id: raise Exception("Telegram成功，但是file_id不存在")
            message_id = msg.get("message_id")
            if not message_id: raise Exception("Telegram成功，但是message_id不存在")
            cost = time.time() - start
            print(f"TG上传完成 {size/1024/1024:.2f}MB 耗时 {cost:.2f}s")
            print(f"TG file_id={file_id}, message_id={message_id}")
            return {"file_id": file_id,"message_id": message_id}
        except Exception as e:
            print(f"TG处理异常 第{attempt}/{max_retry}:", mask_token(str(e)))
            if telegram_received:
                print("Telegram已经接收文件，禁止重新上传")
                raise TelegramUploadedException(f"Telegram已接收文件，但是后续处理失败:{mask_token(str(e))}")
            if attempt < max_retry:
                print("5秒后重试上传")
                time.sleep(5)
            else:
                raise Exception("Telegram上传失败，重试结束")

def upload_photo_to_telegram(file_path):
    if not os.path.exists(file_path):
        raise Exception(f"缩略图不存在:{file_path}")
    if os.path.getsize(file_path) == 0:
        raise Exception(f"缩略图为空:{file_path}")
    url = f"{TG_LOCAL_API}/bot{TG_BOT_TOKEN}/sendPhoto"
    max_retry = 3
    for attempt in range(1, max_retry + 1):
        print(f"上传缩略图 第{attempt}/{max_retry}次")
        telegram_received = False
        try:
            with open(file_path, "rb") as f:
                r = requests.post(url, data={"chat_id": TG_CHAT_ID}, files={"photo": f}, timeout=120)
            if r.status_code == 429:
                retry_after = 5
                try:
                    err_data = r.json(); retry_after = err_data.get("parameters", {}).get("retry_after", 5)
                except Exception: pass
                print(f"⚠️ Telegram 限流 429，等待 {retry_after} 秒后重试 (第 {attempt}/{max_retry} 次)")
                if attempt < max_retry:
                    time.sleep(retry_after + 1); continue
                else:
                    raise Exception(f"Telegram 限流，重试 {max_retry} 次后仍失败 (retry_after={retry_after})")
            if r.status_code != 200: raise Exception(f"Telegram HTTP错误:{r.status_code}")
            try: result = r.json()
            except Exception: raise Exception(f"Telegram返回非JSON:{r.text[:500]}")
            if not result.get("ok"): raise Exception(f"Telegram返回失败:{result}")
            telegram_received = True
            msg = result.get("result")
            if not msg: raise Exception("Telegram成功，但是result不存在")
            photos = msg.get("photo")
            if not photos: raise Exception(f"Telegram成功，但是photo字段不存在:{msg.keys()}")
            file_id = photos[-1].get("file_id")
            if not file_id: raise Exception("Telegram成功，但是file_id不存在")
            print("缩略图上传完成:", file_id)
            message_id = msg.get("message_id")
            if not message_id: raise Exception("Telegram成功，但是message_id不存在")
            return {"file_id": file_id, "message_id":message_id}
        except Exception as e:
            print(f"缩略图处理异常 第{attempt}/{max_retry}:", mask_token(str(e)))
            if telegram_received:
                print("Telegram已经接收缩略图，禁止重新上传")
                raise TelegramUploadedException(f"Telegram已接收缩略图，但是处理失败:{mask_token(str(e))}")
            if attempt < max_retry:
                print("3秒后重试缩略图上传")
                time.sleep(3)
            else:
                raise Exception("缩略图上传失败，重试结束")

def update_tg_pending(shortId, result):
    try:
        print(f"保存TG_PENDING状态 {shortId}")
        r = requests.post(UPDATE_STATUS_URL, headers={"Content-Type":"application/json","X-Oracle-Secret":ORACLE_SECRET}, json={"shortId":shortId,"status":"TG_UPLOADED_PENDING_SYNC","source":"R2","r2_deleted":"0","tg":result}, timeout=15)
        print("TG_PENDING返回:", r.text)
        return r.status_code >= 200 and r.status_code < 300
    except Exception as e:
        print("保存TG_PENDING失败:",e)
        return False

def get_telegram_file_info(file_id, retry=1):
    url = f"{TG_LOCAL_API}/bot{TG_BOT_TOKEN}/getFile"
    for attempt in range(1, retry+1):
        try:
            print(f"获取Telegram文件信息 {attempt}/{retry}: {file_id}")
            r = requests.get(url, params={"file_id": file_id}, timeout=(10,120))
            result = r.json()
            if result.get("ok"):
                info = result["result"]
                if info.get("file_path"): return info
                print("file_path还未生成")
            else: print(mask_token(result))
        except Exception as e: print("getFile异常:", mask_token(str(e)))
        time.sleep(2)
    return {}


# ========== 自动删除R2（带重试） ==========
def auto_delete_r2(shortId, fileKey):
    url = "http://127.0.0.1:8000/delete-r2"
    for attempt in range(1, 4):
        try:
            print(f"自动删除R2 第{attempt}/3次: {shortId}")
            r = requests.post(url, headers={"Content-Type":"application/json","X-Process-Secret":PROCESS_SECRET}, json={"shortId":shortId,"fileKey":fileKey}, timeout=60)
            print("自动删除R2返回:", r.text)
            if r.status_code == 200: return True
            raise Exception(r.text)
        except Exception as e:
            print(f"自动删除R2失败 (第{attempt}次):", e)
            if attempt < 3: time.sleep(5)
    return False

# ========== 自动完成迁移（带重试） ==========
def auto_complete_migration(shortId):
    url = "http://127.0.0.1:8000/complete-migration"
    for attempt in range(1, 4):
        try:
            print(f"自动完成迁移 第{attempt}/3次: {shortId}")
            r = requests.post(url, headers={"Content-Type":"application/json","X-Process-Secret":PROCESS_SECRET}, json={"shortId":shortId,"r2_deleted":"completed"}, timeout=60)
            print("自动完成迁移返回:", r.text)
            if r.status_code == 200: return True
            else: raise Exception(r.text)
        except Exception as e:
            print(f"自动完成迁移失败 (第{attempt}次):", e)
            if attempt < 3: time.sleep(5)
    return False

def migration_cleanup(shortId, fileKey):
    if shortId in migration_lock:
        print("迁移已经执行，跳过:", shortId)
        return
    migration_lock.add(shortId)
    try:
        print("==========开始后台迁移==========")
        deleted = auto_delete_r2(shortId, fileKey)
        if not deleted:
            print("R2删除失败，等待重试")
            return
        completed = auto_complete_migration(shortId)
        if not completed:
            print("完成迁移失败")
            return
        print("后台迁移完成:", shortId)
    finally:
        migration_lock.discard(shortId)

@app.post("/process")
async def process(data: ProcessRequest, background_tasks: BackgroundTasks, x_process_secret: str = Header(None)):
    if x_process_secret != PROCESS_SECRET: raise HTTPException(status_code=401)
    shortId = data.shortId; workdir = None
    tg_pending_result = None
    print("==================="); print("收到任务:", data.dict())

    folder_path = (data.folderPath or "").strip()
    if folder_path:
        if not folder_path.startswith("/"):
            folder_path = "/" + folder_path
        if folder_path.endswith("/") and len(folder_path) > 1:
            folder_path = folder_path[:-1]

    is_screenshot_folder = (folder_path == "/visual/截图")
    print("folder_path:", folder_path, "is_screenshot_folder:", is_screenshot_folder)    

    try:
        update_status(shortId, "processing")
        folderId = Path(shortId).stem
        workdir = f"/tmp/ffmpeg-worker/{folderId}"
        Path(workdir).mkdir(parents=True, exist_ok=True)
        print("工作目录:", workdir)
        safe_name = Path(data.fileName).name
        input_file = f"{workdir}/{safe_name}"
        download_file(data.fileKey, input_file)
        print("文件准备完成:", input_file)

        if is_video(data.fileType, safe_name):
            # ============ 视频分支（原有逻辑不动）============
            video_name = Path(safe_name).stem + ".mp4"
            output_file = f"{workdir}/processed_{video_name}"
            encode = need_encode(safe_name)
            run_ffmpeg(input_file, output_file, encode)
            thumbnail_file = f"{workdir}/{Path(safe_name).stem}.jpg"
            generate_thumbnail(output_file, thumbnail_file)
            video_result = upload_to_telegram(output_file, video_name)
            tg_pending_result = {"type":"video","video":{"file_id": video_result["file_id"],"message_id": video_result["message_id"]},"pending":True}
            if not update_tg_pending(shortId, tg_pending_result): raise Exception("TG视频PENDING状态保存失败")
            thumbnail_result = upload_photo_to_telegram(thumbnail_file)
            tg_pending_result["thumbnail"] = {"file_id": thumbnail_result["file_id"],"message_id": thumbnail_result["message_id"]}
            if not update_tg_pending(shortId, tg_pending_result):raise Exception("TG视频+缩略图PENDING状态保存失败")
            print("等待Telegram Local API生成file_path...")
            time.sleep(3)
            print("并发获取Telegram文件信息...")
            start_wait = time.time()
            with ThreadPoolExecutor(max_workers=2) as executor:
                video_future = executor.submit(get_telegram_file_info, video_result["file_id"],1)
                thumbnail_future = executor.submit(get_telegram_file_info, thumbnail_result["file_id"],1)
                video_info = video_future.result()
                thumbnail_info = thumbnail_future.result()
            print(f"第一次并发getFile耗时: {time.time() - start_wait:.2f}s")
            if not video_info.get("file_path") or not thumbnail_info.get("file_path"):
                print("视频第一次getFile没有file_path，继续轮询")
                for _ in range(10):
                    if (video_info.get("file_path") and thumbnail_info.get("file_path")):break
                    time.sleep(2)
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        video_future = executor.submit(get_telegram_file_info,video_result["file_id"],1)
                        thumbnail_future = executor.submit(get_telegram_file_info,thumbnail_result["file_id"],1)
                        video_info = video_future.result()
                        thumbnail_info = thumbnail_future.result()
            if not video_info or not video_info.get("file_path"): raise Exception("Telegram视频 getFile 失败，未获得 file_path")
            if not thumbnail_info or not thumbnail_info.get("file_path"): raise Exception("Telegram缩略图 getFile 失败，未获得 file_path")
            local_size = os.path.getsize(output_file)
            tg_size = video_info.get("file_size")
            print(f"本地文件大小: {local_size}")
            print(f"Telegram文件大小: {tg_size}")
            if tg_size is not None and tg_size != local_size: raise Exception(f"TG上传文件大小异常: local={local_size}, tg={tg_size}")
            result = {
                "type": "video",
                "video": {"file_id": video_result["file_id"],"file_path": video_info["file_path"],"original_size": data.fileSize,"file_size": tg_size},
                "thumbnail": {"file_id": thumbnail_result["file_id"],"file_path": thumbnail_info["file_path"],"file_size": thumbnail_info.get("file_size")}
            }

        elif is_image(data.fileType, safe_name):
            # ============ ⭐ 图片分支（新增）============
            print("========== 图片处理开始 ==========")
            # ⭐ /截图 文件夹图片：跳过 FFmpeg 缩略图，直接使用原图
            if is_screenshot_folder:
                print("检测到 /截图 文件夹图片：跳过 FFmpeg 缩略图生成")

                # 原图上传 TG（Document）
                original_result = upload_to_telegram(input_file)

                tg_pending_result = {
                    "type": "image",
                    "file": {
                        "file_id": original_result["file_id"],
                        "message_id": original_result["message_id"]
                    },
                    "pending": True
                }

                if not update_tg_pending(shortId, tg_pending_result):
                    raise Exception("TG图片PENDING状态保存失败")

                # 不生成 thumbnail，不写 thumbnail_file_id
                result = {
                    "type": "image",
                    "file": {
                        "file_id": original_result["file_id"],
                        "file_size": os.path.getsize(input_file)
                    }
                }

                saved = update_tg_info_safe(shortId, result)
                if not saved:
                    print("警告：截图图片TG已上传，但D1状态同步失败")
                    if not update_tg_pending(shortId, tg_pending_result):
                        update_status(shortId, "TG_UPLOADED_PENDING_SYNC")
                    raise HTTPException(
                        status_code=500,
                        detail={
                            "message": "TG上传成功，但是D1状态同步失败",
                            "retry": False,
                            "shortId": shortId,
                            "status": "TG_UPLOADED_PENDING_SYNC"
                        }
                    )

                background_tasks.add_task(migration_cleanup, shortId, data.fileKey)
                print("========== 截图图片处理完成（无缩略图，D1已写） ==========")

                return {
                    "success": True,
                    "shortId": shortId,
                    "message": "TG上传完成，后台迁移中",
                    "result": result
                }

            # 1. FFmpeg 压缩生成缩略图（最长边 1280px）
            thumb_name = f"thumb_{Path(safe_name).stem}.jpg"
            thumb_file = f"{workdir}/{thumb_name}"
            compress_image(input_file, thumb_file, max_size=1280, quality=3)

            # 2. 原图上传 TG（Document）
            print("原图上传 TG...")
            original_result = upload_to_telegram(input_file)
            tg_pending_result = {"type":"image","file":{"file_id": original_result["file_id"],"message_id": original_result["message_id"]},"pending":True}
            if not update_tg_pending(shortId, tg_pending_result):
                raise Exception("TG图片PENDING状态保存失败")

            # 3. 缩略图上传 TG（Photo）
            print("缩略图上传 TG...")
            thumbnail_result = upload_photo_to_telegram(thumb_file)
            tg_pending_result["thumbnail"] = {"file_id": thumbnail_result["file_id"],"message_id": thumbnail_result["message_id"]}
            if not update_tg_pending(shortId, tg_pending_result):
                raise Exception("TG图片+缩略图PENDING状态保存失败")

            # 4. 等待 TG 生成缩略图 file_path
            print("等待Telegram生成缩略图 file_path...")
            time.sleep(2)
            thumbnail_info = get_telegram_file_info(thumbnail_result["file_id"])
            if not thumbnail_info.get("file_path"):
                print("第一次 getFile 没有 file_path，轮询...")
                for _ in range(10):
                    time.sleep(2)
                    thumbnail_info = get_telegram_file_info(thumbnail_result["file_id"], retry=1)
                    if thumbnail_info.get("file_path"): break
            if not thumbnail_info or not thumbnail_info.get("file_path"):
                raise Exception("Telegram缩略图 getFile 失败，未获得 file_path")

            print(f"缩略图本地 path: {mask_token(thumbnail_info['file_path'])}")

            # 5. 构建最终 result
            result = {
                "type": "image",
                "file": {
                    "file_id": original_result["file_id"],
                    "file_size": os.path.getsize(input_file)
                },
                "thumbnail": {
                    "file_id": thumbnail_result["file_id"],
                    "file_path": thumbnail_info["file_path"],
                    "file_size": thumbnail_info.get("file_size")
                }
            }

            # 6. ⭐ 先写 D1（tg + thumbnail_url 一次写入）
            saved = update_tg_info_safe(shortId, result)
            if not saved:
                print("警告：图片TG已上传，但D1状态同步失败")
                # ⭐ 改用 update_tg_pending，保留完整 tg 数据，便于后续 /sync-tg 恢复
                if not update_tg_pending(shortId, tg_pending_result):
                    update_status(shortId, "TG_UPLOADED_PENDING_SYNC")
                raise HTTPException(status_code=500, detail={"message": "TG上传成功，但是D1状态同步失败","retry": False,"shortId": shortId,"status":"TG_UPLOADED_PENDING_SYNC"})

            # 7. ⭐ 图片分支单独完成迁移 + 返回（不走底部公共代码）
            background_tasks.add_task(migration_cleanup, shortId, data.fileKey)
            print("========== 图片处理完成（D1已写，打标由 Worker 负责） ==========")
            return {"success": True, "shortId": shortId, "message": "TG上传完成，后台迁移中", "result": result}

        else:
            # ============ 其他文件（原有逻辑不动）============
            file_result = upload_to_telegram(input_file)
            tg_pending_result = {"type":"file","file":{"file_id":file_result["file_id"],"message_id":file_result["message_id"]},"pending":True}
            if not update_tg_pending(shortId, tg_pending_result): raise Exception("TG_PENDING状态保存失败")
            print("第一次获取Telegram文件信息...")
            file_info = get_telegram_file_info(file_result["file_id"])
            if not file_info.get("file_path"):
                print("文件第一次getFile没有file_path，继续轮询")
                for i in range(10):
                    time.sleep(2)
                    file_info = get_telegram_file_info(file_result["file_id"], retry=1)
                    if file_info.get("file_path"):
                        print("Telegram file_path 已生成")
                        break
            if not file_info or not file_info.get("file_path"): raise Exception("Telegram文件file_path获取失败")
            local_size = os.path.getsize(input_file); tg_size = file_info.get("file_size")
            if tg_size is not None and tg_size != local_size: raise Exception(f"TG文件上传异常 local={local_size}, tg={tg_size}")
            result = {"type": "file", "file": {"file_id": file_result["file_id"], "file_path": file_info["file_path"], "file_size": file_info.get("file_size")}}

        # ⭐ 视频和其他文件走这里，图片已在分支内 return
        saved = update_tg_info_safe(shortId, result)
        if not saved:
            print("警告：TG文件已经存在，但是状态同步失败")
            update_status(shortId,"TG_UPLOADED_PENDING_SYNC")
            raise HTTPException(status_code=500, detail={"message": "TG上传成功，但是D1状态同步失败","retry": False,"shortId": shortId,"status":"TG_UPLOADED_PENDING_SYNC"})
        background_tasks.add_task(migration_cleanup, shortId, data.fileKey)
        print("TG上传完成，后台开始删除R2和完成迁移")
        return {"success": True, "shortId": shortId, "message": "TG上传完成，后台迁移中", "result": result}

    except HTTPException: raise
    except TelegramUploadedException as e:
        print("TG已经上传成功，但是后续处理失败:", e)
        if tg_pending_result:
            saved = update_tg_pending(shortId,tg_pending_result)
            if not saved:
                update_status(shortId,"TG_UPLOADED_PENDING_SYNC")
        else:update_status(shortId,"failed")
        raise HTTPException(status_code=500, detail="Telegram文件已经上传，但后续同步失败，请执行TG恢复")
    except Exception as e:
        print("任务失败:", mask_token(str(e)))
        if tg_pending_result:
            print("检测到TG已上传，进入TG_UPLOADED_PENDING_SYNC")
            saved = update_tg_pending(shortId,tg_pending_result)
            if not saved: update_status(shortId,"TG_UPLOADED_PENDING_SYNC")
        else:
            update_status(shortId,"failed")
        raise HTTPException(status_code=500, detail=mask_token(str(e)))
    finally:
        if workdir:
            try:
                shutil.rmtree(workdir, ignore_errors=True)
                print("清理临时目录完成")
            except Exception as e:
                print("清理失败:",e)

@app.post("/sync-tg")
async def sync_tg(data: dict, background_tasks: BackgroundTasks, x_process_secret: str = Header(None)):
    if x_process_secret != PROCESS_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    shortId = data.get("shortId"); fileKey = data.get("fileKey"); file_id = data.get("file_id")
    thumbnail_file_id = data.get("thumbnail_file_id"); file_type = data.get("file_type")
    if not shortId or not fileKey: raise HTTPException(status_code=400, detail="缺少shortId或fileKey")
    if not file_id: raise HTTPException(status_code=400, detail="缺少Telegram file_id")
    try:
        print("========================================")
        print("开始恢复Telegram状态:", shortId)
        print("video/file file_id:", file_id)
        print("thumbnail_file_id:", thumbnail_file_id)
        print("file_type:", file_type)

        # ⭐ 判断类型：视频 或 图片
        video = False
        image = False
        if file_type:
            if str(file_type).startswith("video/"): video = True
            elif str(file_type).startswith("image/"): image = True

        print("重新获取Telegram file_path...")
        file_info = {}
        for attempt in range(1, 11):
            print(f"重新获取主文件信息 第 {attempt}/10")
            file_info = get_telegram_file_info(file_id, retry=1)
            if file_info.get("file_path"):
                print("Telegram主文件 file_path 已获取:", mask_token(file_info.get("file_path")))
                break
            if attempt < 10: time.sleep(2)
        if not file_info or not file_info.get("file_path"):
            raise Exception("Telegram主文件 getFile失败，未获得 file_path")

        # ⭐ 缩略图恢复：视频必须走；图片有 thumbnail_file_id 才走
        thumbnail_info = {}

        if video:
            if not thumbnail_file_id:
                raise Exception("视频缺少 thumbnail_file_id，无法恢复缩略图")
            print("重新获取Telegram缩略图 file_path...")
            for attempt in range(1, 11):
                print(f"重新获取缩略图信息 第 {attempt}/10")
                thumbnail_info = get_telegram_file_info(thumbnail_file_id, retry=1)
                if thumbnail_info.get("file_path"):
                    print("Telegram缩略图 file_path 已获取:", mask_token(thumbnail_info.get("file_path")))
                    break
                if attempt < 10:
                    time.sleep(2)
            if not thumbnail_info or not thumbnail_info.get("file_path"):
                raise Exception("Telegram缩略图 getFile失败，未获得 file_path")

        elif image and thumbnail_file_id:
            print("重新获取Telegram缩略图 file_path...")
            for attempt in range(1, 11):
                print(f"重新获取缩略图信息 第 {attempt}/10")
                thumbnail_info = get_telegram_file_info(thumbnail_file_id, retry=1)
                if thumbnail_info.get("file_path"):
                    print("Telegram缩略图 file_path 已获取:", mask_token(thumbnail_info.get("file_path")))
                    break
                if attempt < 10:
                    time.sleep(2)
            if not thumbnail_info or not thumbnail_info.get("file_path"):
                raise Exception("Telegram缩略图 getFile失败，未获得 file_path")

        elif image and not thumbnail_file_id:
            print("图片没有 thumbnail_file_id，按无缩略图恢复")

        # ⭐ 构建 result
        if video:
            result = {
                "type": "video",
                "video": {
                    "file_id": file_id,
                    "file_path": file_info["file_path"],
                    "file_size": file_info.get("file_size")
                },
                "thumbnail": {
                    "file_id": thumbnail_file_id,
                    "file_path": thumbnail_info["file_path"],
                    "file_size": thumbnail_info.get("file_size")
                }
            }
        elif image:
            if thumbnail_file_id and thumbnail_info.get("file_path"):
                result = {
                    "type": "image",
                    "file": {
                        "file_id": file_id,
                        "file_path": file_info["file_path"],
                        "file_size": file_info.get("file_size")
                    },
                    "thumbnail": {
                        "file_id": thumbnail_file_id,
                        "file_path": thumbnail_info["file_path"],
                        "file_size": thumbnail_info.get("file_size")
                    }
                }
            else:
                result = {
                    "type": "image",
                    "file": {
                        "file_id": file_id,
                        "file_path": file_info["file_path"],
                        "file_size": file_info.get("file_size")
                    }
                }
        else:
            result = {
                "type": "file",
                "file": {
                    "file_id": file_id,
                    "file_path": file_info["file_path"],
                    "file_size": file_info.get("file_size")
                }
            }

        print("恢复后的TG数据:")
        print(mask_token(result))

        # ⭐ 一次性写回 D1（tg + file_id + thumbnail_file_id）
        saved = update_tg_info_safe(shortId, result)
        if not saved:
            raise Exception("TG状态同步失败：update_tg_info_safe 返回 False")
        print("Telegram状态恢复成功:", shortId)

        #  后台迁移
        background_tasks.add_task(migration_cleanup, shortId, fileKey)
        print("TG恢复成功，后台继续迁移:", shortId)
        return {"success": True,"shortId": shortId,"message": "Telegram状态恢复成功，后台开始迁移","result": result}
    except Exception as e:
        print("Telegram状态恢复失败:", mask_token(repr(e)))
        raise HTTPException(status_code=500, detail=mask_token(str(e)))

@app.post("/delete-r2")
async def delete_r2(data: dict, x_process_secret: str = Header(None)):
    if x_process_secret != PROCESS_SECRET: raise HTTPException(status_code=401, detail="Unauthorized")
    shortId = data["shortId"]; fileKey = data["fileKey"]
    try:
        print("开始删除R2:", fileKey)
        s3.delete_object(Bucket=MY_BUCKET, Key=fileKey)
        time.sleep(2)
        try:
            s3.head_object(Bucket=MY_BUCKET, Key=fileKey)
            raise Exception("R2删除失败，文件仍存在")
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code not in ["404", "NoSuchKey", "NotFound"]: raise
        print("R2删除成功")
        return {"success": True, "message":"R2删除成功"}
    except Exception as e:
        print("R2删除失败:", e)
        raise HTTPException(status_code=500, detail=f"R2删除失败:{str(e)}")

@app.post("/complete-migration")
async def complete_migration(data: dict, x_process_secret:str = Header(None)):
    if x_process_secret != PROCESS_SECRET: raise HTTPException(status_code=401, detail="Unauthorized")
    shortId=data["shortId"]
    if data.get("r2_deleted") != "completed": raise HTTPException(status_code=400, detail="R2还未删除完成")
    try:
        print("开始完成迁移:",shortId)
        r = requests.post(UPDATE_STATUS_URL, headers={"Content-Type":"application/json","X-Oracle-Secret":ORACLE_SECRET}, json={"shortId":shortId,"status":"completed","source":"TG","r2_deleted":"completed"}, timeout=15)
        print("完成迁移返回:",r.text)
        if r.status_code < 200 or r.status_code >=300: raise Exception(r.text)
        return {"success":True,"message":"迁移完成"}
    except Exception as e:
        print("完成迁移失败:",e)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/resume-migration")
async def resume_migration(data: dict, background_tasks: BackgroundTasks, x_process_secret: str = Header(None)):
    if x_process_secret != PROCESS_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    shortId = data.get("shortId"); fileKey = data.get("fileKey")
    if not shortId or not fileKey: raise HTTPException(status_code=400, detail="缺少参数")
    print("继续迁移:", shortId)
    background_tasks.add_task(migration_cleanup, shortId, fileKey)
    return {"success": True,"shortId": shortId,"message": "已开始继续迁移"}

@app.api_route("/tg-file/{file_path:path}", methods=["GET","HEAD"])
async def tg_file(file_path: str, request: Request, x_oracle_secret: str = Header(None)):
    if x_oracle_secret != ORACLE_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    import re
    import mimetypes

    # 兼容旧格式：剥掉 /var/lib/telegram-bot-api 前缀
    if file_path.startswith("/var/lib/telegram-bot-api"):
        file_path = file_path[len("/var/lib/telegram-bot-api"):]
    elif file_path.startswith("var/lib/telegram-bot-api"):
        file_path = file_path[len("var/lib/telegram-bot-api"):]

    # 剥掉可能存在的 token 段（数字:字母数字/）
    parts = file_path.lstrip("/").split("/", 1)
    if len(parts) == 2 and ":" in parts[0]:
        file_path = parts[1]
    
    if ".." in file_path:
        raise HTTPException(status_code=400, detail="Bad path")

    # ⭐ 用 Oracle 自己的 token 拼
    local_file = (TG_ROOT / TG_BOT_TOKEN / file_path.lstrip("/")).resolve()

    # ⭐ 锁死在这个 bot 的目录下
    try:
        local_file.relative_to((TG_ROOT / TG_BOT_TOKEN).resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Forbidden")

    # ⭐ 拒绝目录 / 不存在的文件
    if not local_file.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    # file_path 是剥过的相对路径，无 token
    print("READ TG FILE:", file_path)
    file_size = os.path.getsize(local_file)
    mtime = os.path.getmtime(local_file)
    etag = f'"{file_path}-{file_size}-{int(mtime)}"'
    last_modified = formatdate(mtime, usegmt=True)
    range_header = request.headers.get("range")
    if not range_header:
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Last-Modified": last_modified})
    if request.headers.get("if-modified-since"):
        try:
            since = parsedate_to_datetime(request.headers["if-modified-since"]).timestamp()
            if int(since) >= int(mtime):
                return Response(status_code=304, headers={"ETag": etag, "Last-Modified": last_modified})
        except Exception: pass
    start = 0; end = file_size - 1
    if range_header:
        match = re.match(r"^bytes=(\d*)-(\d*)$", range_header)
        if match:
            range_start = match.group(1); range_end = match.group(2)
            if range_start:
                start = int(range_start)
                if range_end: end = int(range_end)
            elif range_end:
                length = int(range_end)
                if length == 0: raise HTTPException(status_code=416, detail="Invalid Range")
                start = max(file_size - length, 0); end = file_size - 1
        else:
            raise HTTPException(status_code=416, detail="Invalid Range")
    if start >= file_size:
        return Response(status_code=416,headers={"Content-Range": f"bytes */{file_size}"})
    READ_SIZE = 8 * 1024 * 1024
    if end >= file_size: end = file_size - 1
    if end < start:
        return Response(status_code=416,headers={"Content-Range":f"bytes */{file_size}"})
    length = end - start + 1
    def iter_file():
        with open(local_file, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(READ_SIZE, remaining))
                if not chunk: break
                remaining -= len(chunk)
                yield chunk
    content_type, _ = mimetypes.guess_type(str(local_file))
    if not content_type: content_type = "application/octet-stream"
    cache_time = "public,max-age=2592000"
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "ETag": etag,
        "Content-Type": content_type,
        "Last-Modified": last_modified,
        "Cache-Control": cache_time,
    }
    if range_header: headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    status_code = 206 if range_header else 200
    if request.method == "HEAD": return Response(status_code=status_code, headers=headers)
    return StreamingResponse(iter_file(), status_code=status_code, headers=headers, media_type=content_type)

# ==========================================
# 🌟 新增：外链转存 TG 接口 (无需鉴权)
# ==========================================
@app.get("/proxy-image")
async def proxy_image(url: str):
    try:
        print(f"===== 开始处理转存: {url}")
        
        # 🔥 关键修复：加上 Authorization 头
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.bilibili.com/",
            "Authorization": f"Bearer {KARAKEEP_TOKEN}" # 🔥 新增这一行
        }
        
        img_res = requests.get(url, headers=headers, timeout=15)
        print(f"1. 图片下载状态: {img_res.status_code}")
        
        if img_res.status_code != 200:
            print(f"❌ 图片下载失败，状态码: {img_res.status_code}, 内容: {img_res.text[:200]}")
            raise HTTPException(status_code=400, detail=f"图片下载失败，状态码: {img_res.status_code}")

        print(f"2. 图片大小: {len(img_res.content)} bytes")

        # 上传到 TG Local API
        tg_url = f"{TG_LOCAL_API}/bot{TG_BOT_TOKEN}/sendPhoto"
        files = {'photo': ('cover.jpg', io.BytesIO(img_res.content), 'image/jpeg')}
        data = {'chat_id': TG_CHAT_ID}
        
        tg_res = requests.post(tg_url, files=files, data=data, timeout=30)
        print(f"3. TG 上传响应状态: {tg_res.status_code}")
        print(f"4. TG 响应内容: {tg_res.text[:500]}")

        try:
            result = tg_res.json()
        except Exception as e:
            print(f"❌ TG 返回非 JSON 格式: {e}")
            raise HTTPException(status_code=500, detail=f"TG 接口返回异常: {tg_res.text[:100]}")

        if not result.get("ok"):
            print(f"❌ TG 返回失败: {result}")
            raise HTTPException(status_code=500, detail="TG 上传失败")

        file_id = result['result']['photo'][-1]['file_id']
        print(f"✅ 转存成功，file_id: {file_id}")
        return {"success": True, "file_id": file_id}
        
    except Exception as e:
        # 🔥 最关键的一步：打印详细的异常栈
        import traceback
        print("=" * 50)
        print(f"❌ /proxy-image 接口报错: {repr(e)}")
        traceback.print_exc()  # 打印报错在哪个文件哪一行
        print("=" * 50)
        raise HTTPException(status_code=500, detail=str(e))



# ==========================================
# 🌟 终极兜底：前端拿图接口（本地优先版）
# ==========================================
@app.get("/image/{file_id}")
async def get_image_by_file_id(file_id: str):
    try:
        print(f"===== 开始请求图片: {file_id}")

        # 1. 查询 Telegram 获取 file_path
        get_file_url = f"{TG_LOCAL_API}/bot{TG_BOT_TOKEN}/getFile"

        file_response = requests.get(
            get_file_url,
            params={"file_id": file_id},
            timeout=30
        )

        file_response.raise_for_status()
        file_res = file_response.json()

        if not file_res.get("ok"):
            raise HTTPException(
                status_code=404,
                detail="获取 TG 文件路径失败"
            )

        file_path = file_res.get("result", {}).get("file_path", "")

        if not file_path:
            raise HTTPException(
                status_code=404,
                detail="TG 文件不存在"
            )

        # 2. 将 Telegram 返回的路径映射到实际存储目录
        #
        # Telegram 返回：
        # /var/lib/telegram-bot-api/{TOKEN}/photos/file_1307.jpg
        #
        # 实际存储：
        # /data/telegram-bot-api/{TOKEN}/photos/file_1307.jpg

        telegram_root = Path("/var/lib/telegram-bot-api")
        returned_path = Path(file_path)

        if returned_path.is_absolute():
            try:
                relative_path = returned_path.relative_to(telegram_root)

                local_file = (
                    TG_ROOT / relative_path
                ).resolve()

                # 防止路径越界
                if not local_file.is_relative_to(TG_ROOT.resolve()):
                    raise HTTPException(
                        status_code=403,
                        detail="非法文件路径"
                    )

            except ValueError:
                # 如果不是 Telegram 标准存储路径，则尝试直接读取
                local_file = returned_path

        else:
            local_file = (
                TG_ROOT / TG_BOT_TOKEN / file_path.lstrip("/")
            ).resolve()

            if not local_file.is_relative_to(TG_ROOT.resolve()):
                raise HTTPException(
                    status_code=403,
                    detail="非法文件路径"
                )

        print(f"Telegram 返回路径: {file_path}")
        print(f"实际读取路径: {local_file}")

        # 3. 优先读取本地文件
        if local_file.is_file():

            print(f"✅ 本地图片读取成功: {local_file}")

            content_type, _ = mimetypes.guess_type(str(local_file))

            if not content_type:
                content_type = "application/octet-stream"

            return FileResponse(
                path=str(local_file),
                media_type=content_type
            )

        # 4. 本地文件不存在时，尝试通过 Telegram Local Bot API 下载
        print(f"⚠️ 本地文件不存在，尝试通过 TG API 下载: {file_id}")

        download_url = (
            f"{TG_LOCAL_API}/file/bot{TG_BOT_TOKEN}/{file_path}"
        )

        download_response = requests.get(
            download_url,
            stream=True,
            timeout=60
        )

        if download_response.status_code == 200:

            print(f"✅ TG 文件接口返回成功: {file_path}")

            content_type = download_response.headers.get(
                "Content-Type",
                "application/octet-stream"
            )

            def generate():
                try:
                    for chunk in download_response.iter_content(
                        chunk_size=8192
                    ):
                        if chunk:
                            yield chunk
                finally:
                    download_response.close()

            return StreamingResponse(
                generate(),
                media_type=content_type
            )

        else:
            print(
                f"❌ TG 文件接口下载失败，状态码: "
                f"{download_response.status_code}"
            )

            raise HTTPException(
                status_code=404,
                detail="本地文件不存在，TG 文件接口下载也失败"
            )

    except HTTPException:
        raise

    except requests.RequestException as e:
        print(f"❌ TG 请求失败: {e}")

        raise HTTPException(
            status_code=502,
            detail=f"Telegram API 请求失败: {str(e)}"
        )

    except Exception as e:
        print(f"❌ /image 接口报错: {e}")

        raise HTTPException(
            status_code=500,
            detail=str(e)
        )

import subprocess
import json

@app.get("/yt-dlp-meta")
async def yt_dlp_meta(url: str):
    try:
        cmd = [
            "/home/ubuntu/ffmpeg-worker/venv/bin/yt-dlp",
            "--dump-json", "--no-download",
            "--js-runtimes", "deno:/home/ubuntu/.deno/bin/deno",
            "--remote-components", "ejs:github",
            "--cookies", "/home/ubuntu/ffmpeg-worker/cookies.txt",
            url
        ]
        # 🔥 把超时从 60 改到 120
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        
        if result.returncode != 0:
            # 🔥 打印真实错误，方便排查
            print(f"❌ yt-dlp 失败，stderr: {result.stderr}")
            raise HTTPException(status_code=500, detail=f"yt-dlp 失败: {result.stderr[-300:]}")
        
        data = json.loads(result.stdout)
        return {
            "success": True,
            "title": data.get("title"),
            "description": data.get("description"),
            "uploader": data.get("uploader"),
            "thumbnail": data.get("thumbnail")
        }
    except subprocess.TimeoutExpired:
        print("❌ yt-dlp 执行超时（超过120秒）")
        raise HTTPException(status_code=500, detail="yt-dlp 执行超时")
    except Exception as e:
        print(f"❌ yt-dlp-meta 接口异常: {repr(e)}")
        raise HTTPException(status_code=500, detail=str(e))

