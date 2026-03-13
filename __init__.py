"""
ComfyUI RunpodDirect - Direct Model Downloads for RunPod
Download models directly to your RunPod instance with multi-connection support
"""

import os
import logging
import asyncio
import folder_paths
from aiohttp import web
from server import PromptServer

# Track active downloads
active_downloads = {}
# Download control (for pause/resume)
download_control = {}
# Download queue management
download_queue = []
current_download_task = None  # Only one download at a time

# Configuration optimized for datacenter connections (RunPod)
CHUNK_SIZE = 32 * 1024 * 1024  # 32MB chunks - balanced for 500MB to 30GB+ files
NUM_CONNECTIONS = 8  # 8 parallel connections - optimal for DC bandwidth


@PromptServer.instance.routes.post("/server_download/start")
async def start_download(request):
    """Start downloading a model file to the server"""
    try:
        json_data = await request.json()
        url = json_data.get("url")
        save_path = json_data.get("save_path")  # e.g., "checkpoints"
        filename = json_data.get("filename")    # e.g., "model.safetensors"
        token = json_data.get("token")          # Optional HF token for gated models

        if not url or not save_path or not filename:
            return web.json_response(
                {"error": "Missing required parameters: url, save_path, filename"},
                status=400
            )

        # Validate save_path
        if save_path not in folder_paths.folder_names_and_paths:
            return web.json_response(
                {"error": f"Invalid save_path: {save_path}. Must be one of: {list(folder_paths.folder_names_and_paths.keys())}"},
                status=400
            )

        # Security: Validate filename to prevent path traversal attacks
        # Check for any directory separators (both Unix and Windows style)
        if "/" in filename or "\\" in filename or os.path.sep in filename:
            return web.json_response(
                {"error": "Invalid filename: must not contain path separators"},
                status=400
            )

        # Additional check for various path traversal patterns
        if ".." in filename or filename.startswith("/") or filename.startswith("~"):
            return web.json_response(
                {"error": "Invalid filename: path traversal patterns detected"},
                status=400
            )

        # Normalize the filename to remove any potential tricks
        safe_filename = os.path.basename(filename)
        if safe_filename != filename:
            return web.json_response(
                {"error": "Invalid filename: must be a simple filename without path components"},
                status=400
            )

        # Get the first folder path for this model type
        output_dir = folder_paths.folder_names_and_paths[save_path][0][0]
        output_path = os.path.join(output_dir, safe_filename)

        # Final security check: ensure the resolved path is within the intended directory
        output_path = os.path.abspath(output_path)
        output_dir = os.path.abspath(output_dir)
        if not output_path.startswith(output_dir + os.sep):
            return web.json_response(
                {"error": "Security error: attempted directory escape"},
                status=400
            )

        # Check if file already exists
        if os.path.exists(output_path):
            return web.json_response(
                {"error": f"File already exists: {output_path}"},
                status=400
            )

        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Mark as queued
        download_id = f"{save_path}/{safe_filename}"
        active_downloads[download_id] = {
            "url": url,
            "filename": safe_filename,
            "save_path": save_path,
            "output_path": output_path,
            "progress": 0,
            "status": "queued",
            "priority": None
        }

        # Resolve token: prefer explicit token, fall back to HF_TOKEN env var
        resolved_token = token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

        # Add to queue
        download_queue.append({
            "download_id": download_id,
            "url": url,
            "output_path": output_path,
            "token": resolved_token
        })

        # Process queue (will start download if slot available)
        asyncio.create_task(process_download_queue())

        return web.json_response({
            "success": True,
            "download_id": download_id,
            "message": "Download queued"
        })

    except Exception as e:
        logging.error(f"Error starting download: {e}")
        return web.json_response(
            {"error": str(e)},
            status=500
        )


async def process_download_queue():
    """Process the download queue - one download at a time"""
    global download_queue, current_download_task

    # Check if already downloading
    if current_download_task is not None and not current_download_task.done():
        logging.info("[RunpodDirect] Download already in progress, waiting...")
        return  # Already downloading

    if len(download_queue) == 0:
        logging.info("[RunpodDirect] Queue is empty")
        return  # Nothing to process

    # Get next download from queue
    download_item = download_queue.pop(0)
    download_id = download_item["download_id"]
    url = download_item["url"]
    output_path = download_item["output_path"]
    token = download_item.get("token")

    # Set status to downloading
    active_downloads[download_id]["status"] = "downloading"
    active_downloads[download_id]["progress"] = 0
    active_downloads[download_id]["downloaded"] = 0

    logging.info(f"[RunpodDirect] Starting download {download_id} with {NUM_CONNECTIONS} connections (full speed)")

    # Notify frontend that download is starting
    await PromptServer.instance.send("server_download_progress", {
        "download_id": download_id,
        "progress": 0,
        "downloaded": 0,
        "total": 0
    })

    # Start download task
    current_download_task = asyncio.create_task(download_file(url, output_path, download_id, token=token))

    # Add completion callback to process next in queue
    current_download_task.add_done_callback(lambda t: on_download_complete(download_id))


def on_download_complete(download_id):
    """Called when a download completes - processes next in queue"""
    global current_download_task

    current_download_task = None
    logging.info(f"[RunpodDirect] Download completed: {download_id}, processing next in queue...")

    # Process next in queue
    asyncio.create_task(process_download_queue())


async def download_chunk(session, url, start, end, output_path, chunk_index, download_id):
    """Download a specific chunk of the file"""
    headers = {'Range': f'bytes={start}-{end}'}

    try:
        async with session.get(url, headers=headers) as response:
            if response.status not in [200, 206]:
                return None

            chunk_data = await response.read()

            # Write chunk to file at specific position
            with open(output_path, 'r+b') as f:
                f.seek(start)
                f.write(chunk_data)

            return len(chunk_data)
    except Exception as e:
        logging.error(f"Error downloading chunk {chunk_index} for {download_id}: {e}")
        return None


async def download_file(url, output_path, download_id, token=None):
    """Download file with multi-connection support and progress tracking"""
    import aiohttp

    logging.info(f"[RunpodDirect] Download {download_id} using {NUM_CONNECTIONS} connections (full speed)")

    try:
        # Initialize control for this download
        download_control[download_id] = {
            "paused": False,
            "cancelled": False,
            "total_downloaded": 0,  # Shared counter for all chunks
            "lock": asyncio.Lock()   # Lock for thread-safe updates
        }

        # Build auth headers for gated HF models
        auth_headers = {}
        if token and 'huggingface.co' in url:
            auth_headers['Authorization'] = f'Bearer {token}'
            logging.info(f"[RunpodDirect] Using HF token for {download_id}")

        timeout = aiohttp.ClientTimeout(total=None)
        async with aiohttp.ClientSession(timeout=timeout, headers=auth_headers) as session:
            # Get file size - try HEAD first, then fall back to GET with Range
            total_size = 0
            supports_range = False

            # Helper to detect gated/auth errors and produce a useful message
            def _check_gated_error(status_code, request_url):
                if status_code in (401, 403, 451) and 'huggingface.co' in request_url:
                    # Convert download URL to repo URL for the user
                    # e.g. https://huggingface.co/org/repo/resolve/main/file.ext -> https://huggingface.co/org/repo
                    repo_url = request_url
                    resolve_idx = request_url.find('/resolve/')
                    if resolve_idx != -1:
                        repo_url = request_url[:resolve_idx]
                    if status_code == 401:
                        raise Exception(f"Authentication required. Provide a valid HF token. Repo: {repo_url}")
                    elif status_code == 403:
                        raise Exception(f"Access denied — you may need to accept the model's terms at {repo_url}")
                    elif status_code == 451:
                        raise Exception(f"Model is restricted. Accept the license agreement at {repo_url}")

            try:
                # Try HEAD request first
                async with session.head(url, allow_redirects=True) as response:
                    _check_gated_error(response.status, url)
                    if response.status == 200:
                        total_size = int(response.headers.get('content-length', 0))
                        supports_range = response.headers.get('accept-ranges') == 'bytes'
            except Exception as e:
                if 'Accept the license' in str(e) or 'Access denied' in str(e) or 'Authentication required' in str(e):
                    raise
                logging.warning(f"HEAD request failed for {download_id}: {e}")

            # If HEAD didn't give us the size, try GET with Range header
            if total_size == 0:
                logging.info(f"HEAD request didn't return size, trying GET with Range for {download_id}")
                try:
                    headers = {'Range': 'bytes=0-0'}
                    async with session.get(url, headers=headers, allow_redirects=True) as response:
                        _check_gated_error(response.status, url)
                        if response.status in [200, 206]:
                            # Try to get size from Content-Range header first
                            content_range = response.headers.get('content-range', '')
                            if content_range:
                                # Format: "bytes 0-0/12345" where 12345 is total size
                                parts = content_range.split('/')
                                if len(parts) == 2:
                                    total_size = int(parts[1])
                                    supports_range = True

                            # Fallback to Content-Length
                            if total_size == 0:
                                total_size = int(response.headers.get('content-length', 0))
                except Exception as e:
                    if 'Accept the license' in str(e) or 'Access denied' in str(e) or 'Authentication required' in str(e):
                        raise
                    logging.warning(f"GET with Range failed for {download_id}: {e}")

            if total_size == 0:
                raise Exception("Could not determine file size from server")

            logging.info(f"File size for {download_id}: {total_size} bytes, supports range: {supports_range}")

            # Create file with full size
            with open(output_path, 'wb') as f:
                f.seek(total_size - 1)
                f.write(b'\0')

            active_downloads[download_id]["total"] = total_size
            active_downloads[download_id]["downloaded"] = 0

            # Use multi-connection download if server supports range requests
            if supports_range and total_size > CHUNK_SIZE:
                logging.info(f"Using {NUM_CONNECTIONS} connections for {download_id}")

                # Calculate chunk ranges
                chunk_size = total_size // NUM_CONNECTIONS
                tasks = []

                for i in range(NUM_CONNECTIONS):
                    start = i * chunk_size
                    end = start + chunk_size - 1 if i < NUM_CONNECTIONS - 1 else total_size - 1

                    tasks.append(download_chunk_with_progress(
                        session, url, start, end, output_path, i, download_id, total_size
                    ))

                # Download all chunks in parallel
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Check for errors
                for result in results:
                    if isinstance(result, Exception):
                        raise result

            else:
                # Fallback to single connection download
                logging.info(f"Using single connection for {download_id}")
                await download_single_connection(session, url, output_path, download_id, total_size)

            # Check if cancelled
            if download_control[download_id]["cancelled"]:
                os.remove(output_path)
                return

            # Mark as complete
            active_downloads[download_id]["status"] = "completed"
            active_downloads[download_id]["progress"] = 100

            # Send completion message
            await PromptServer.instance.send("server_download_complete", {
                "download_id": download_id,
                "path": output_path,
                "size": total_size
            })

            logging.info(f"Successfully downloaded {download_id} to {output_path}")

            # Cleanup
            del download_control[download_id]

    except Exception as e:
        logging.error(f"Error downloading {download_id}: {e}")
        active_downloads[download_id]["status"] = "error"
        active_downloads[download_id]["error"] = str(e)

        await PromptServer.instance.send("server_download_error", {
            "download_id": download_id,
            "error": str(e)
        })

        # Cleanup
        if download_id in download_control:
            del download_control[download_id]


async def download_chunk_with_progress(session, url, start, end, output_path, chunk_index, download_id, total_size):
    """Download chunk with progress tracking"""
    headers = {'Range': f'bytes={start}-{end}'}
    chunk_size = end - start + 1
    downloaded = 0
    last_report_time = 0

    try:
        async with session.get(url, headers=headers) as response:
            if response.status in (401, 403, 451) and 'huggingface.co' in url:
                repo_url = url[:url.find('/resolve/')] if '/resolve/' in url else url
                raise Exception(f"Access denied — accept the model's terms at {repo_url}")
            if response.status not in [200, 206]:
                raise Exception(f"HTTP {response.status} for chunk {chunk_index}")

            with open(output_path, 'r+b') as f:
                f.seek(start)

                async for chunk in response.content.iter_chunked(CHUNK_SIZE):
                    # Check if paused
                    while download_control.get(download_id, {}).get("paused", False):
                        await asyncio.sleep(0.5)

                    # Check if cancelled
                    if download_control.get(download_id, {}).get("cancelled", False):
                        return

                    f.write(chunk)
                    chunk_len = len(chunk)
                    downloaded += chunk_len

                    # Update shared progress counter with lock
                    async with download_control[download_id]["lock"]:
                        download_control[download_id]["total_downloaded"] += chunk_len
                        total_downloaded = download_control[download_id]["total_downloaded"]

                    # Send progress updates every 100ms to avoid spam (only from chunk 0)
                    import time
                    current_time = time.time()
                    if chunk_index == 0 and (current_time - last_report_time) >= 0.1:
                        progress = (total_downloaded / total_size) * 100
                        active_downloads[download_id]["progress"] = progress
                        active_downloads[download_id]["downloaded"] = total_downloaded

                        await PromptServer.instance.send("server_download_progress", {
                            "download_id": download_id,
                            "progress": progress,
                            "downloaded": total_downloaded,
                            "total": total_size
                        })

                        last_report_time = current_time

    except Exception as e:
        logging.error(f"Error in chunk {chunk_index} for {download_id}: {e}")
        raise


async def download_single_connection(session, url, output_path, download_id, total_size):
    """Fallback single connection download"""
    downloaded_size = 0

    async with session.get(url) as response:
        if response.status in (401, 403, 451) and 'huggingface.co' in url:
            repo_url = url[:url.find('/resolve/')] if '/resolve/' in url else url
            raise Exception(f"Access denied — accept the model's terms at {repo_url}")
        if response.status != 200:
            raise Exception(f"HTTP {response.status}")

        with open(output_path, 'wb') as f:
            async for chunk in response.content.iter_chunked(CHUNK_SIZE):
                # Check if paused
                while download_control.get(download_id, {}).get("paused", False):
                    await asyncio.sleep(0.5)

                # Check if cancelled
                if download_control.get(download_id, {}).get("cancelled", False):
                    return

                f.write(chunk)
                downloaded_size += len(chunk)

                # Update progress
                progress = (downloaded_size / total_size) * 100
                active_downloads[download_id]["progress"] = progress
                active_downloads[download_id]["downloaded"] = downloaded_size

                await PromptServer.instance.send("server_download_progress", {
                    "download_id": download_id,
                    "progress": progress,
                    "downloaded": downloaded_size,
                    "total": total_size
                })


@PromptServer.instance.routes.get("/server_download/status")
async def get_download_status(request):
    """Get status of all downloads"""
    return web.json_response(active_downloads)


@PromptServer.instance.routes.get("/server_download/status/{download_id:.*}")
async def get_single_download_status(request):
    """Get status of a specific download"""
    download_id = request.match_info.get("download_id", "")

    if download_id in active_downloads:
        return web.json_response(active_downloads[download_id])
    else:
        return web.json_response(
            {"error": "Download not found"},
            status=404
        )


@PromptServer.instance.routes.post("/server_download/pause")
async def pause_download(request):
    """Pause an active download"""
    try:
        json_data = await request.json()
        download_id = json_data.get("download_id")

        if not download_id:
            return web.json_response(
                {"error": "Missing download_id"},
                status=400
            )

        if download_id not in download_control:
            return web.json_response(
                {"error": "Download not found or already completed"},
                status=404
            )

        download_control[download_id]["paused"] = True
        active_downloads[download_id]["status"] = "paused"

        await PromptServer.instance.send("server_download_paused", {
            "download_id": download_id
        })

        return web.json_response({"success": True, "message": "Download paused"})

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/server_download/resume")
async def resume_download(request):
    """Resume a paused download"""
    try:
        json_data = await request.json()
        download_id = json_data.get("download_id")

        if not download_id:
            return web.json_response(
                {"error": "Missing download_id"},
                status=400
            )

        if download_id not in download_control:
            return web.json_response(
                {"error": "Download not found or already completed"},
                status=404
            )

        download_control[download_id]["paused"] = False
        active_downloads[download_id]["status"] = "downloading"

        await PromptServer.instance.send("server_download_resumed", {
            "download_id": download_id
        })

        return web.json_response({"success": True, "message": "Download resumed"})

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/server_download/cancel")
async def cancel_download(request):
    """Cancel an active download"""
    global download_queue, current_download_task

    try:
        json_data = await request.json()
        download_id = json_data.get("download_id")

        if not download_id:
            return web.json_response(
                {"error": "Missing download_id"},
                status=400
            )

        # Check if download is queued (not started yet)
        download_queue[:] = [d for d in download_queue if d["download_id"] != download_id]

        # Check if download is active
        if download_id in download_control:
            download_control[download_id]["cancelled"] = True

        # Update status
        if download_id in active_downloads:
            active_downloads[download_id]["status"] = "cancelled"

        await PromptServer.instance.send("server_download_cancelled", {
            "download_id": download_id
        })

        return web.json_response({"success": True, "message": "Download cancelled"})

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/server_download/hf_token_status")
async def hf_token_status(request):
    """Check if HF_TOKEN environment variable is set (without exposing the value)"""
    has_token = bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"))
    return web.json_response({"has_token": has_token})


@PromptServer.instance.routes.post("/server_download/validate_hf_token")
async def validate_hf_token(request):
    """Validate a Hugging Face token and optionally check access to specific model URLs"""
    import aiohttp

    try:
        json_data = await request.json()
        token = json_data.get("token", "")
        urls = json_data.get("urls", [])  # Optional: list of model URLs to check access

        # If token is the sentinel '__env__', use the environment variable
        if token == "__env__":
            token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or ""

        if not token:
            return web.json_response({"valid": False, "error": "No token provided"}, status=400)

        # Validate token against HF API
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            # Check token validity via whoami endpoint
            async with session.get(
                "https://huggingface.co/api/whoami-v2",
                headers={"Authorization": f"Bearer {token}"}
            ) as response:
                if response.status != 200:
                    return web.json_response({"valid": False, "error": "Invalid token"})
                user_data = await response.json()
                username = user_data.get("name", "unknown")

            # If URLs provided, check access to each
            url_access = {}
            for url in urls[:10]:  # Limit to 10 URLs
                try:
                    async with session.head(
                        url,
                        headers={"Authorization": f"Bearer {token}"},
                        allow_redirects=True
                    ) as resp:
                        if resp.status == 200:
                            url_access[url] = {"accessible": True}
                        elif resp.status in (401, 403, 451):
                            repo_url = url[:url.find('/resolve/')] if '/resolve/' in url else url
                            url_access[url] = {
                                "accessible": False,
                                "reason": "terms_not_accepted",
                                "repo_url": repo_url
                            }
                        else:
                            url_access[url] = {"accessible": False, "reason": f"HTTP {resp.status}"}
                except Exception:
                    url_access[url] = {"accessible": False, "reason": "request_failed"}

            return web.json_response({
                "valid": True,
                "username": username,
                "url_access": url_access
            })

    except Exception as e:
        logging.error(f"Error validating HF token: {e}")
        return web.json_response({"valid": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/extensions/ComfyUI-RunpodDirect/serverDownload.js")
async def serve_js_with_version(request):
    """Serve JS file with cache-busting headers"""
    js_path = os.path.join(os.path.dirname(__file__), "web", "serverDownload.js")

    response = web.FileResponse(js_path)
    # Add cache control headers to force revalidation
    response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    response.headers['X-Version'] = __version__

    return response


# Set the web directory for frontend files
WEB_DIRECTORY = "./web"

# Version for cache busting - increment this when you update the JS
__version__ = "1.0.7"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
