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

# Configuration
CHUNK_SIZE = 10 * 1024 * 1024  # 10MB chunks for faster downloads
NUM_CONNECTIONS = 4  # Number of parallel connections per file


@PromptServer.instance.routes.post("/server_download/start")
async def start_download(request):
    """Start downloading a model file to the server"""
    try:
        json_data = await request.json()
        url = json_data.get("url")
        save_path = json_data.get("save_path")  # e.g., "checkpoints"
        filename = json_data.get("filename")    # e.g., "model.safetensors"

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

        # Get the first folder path for this model type
        output_dir = folder_paths.folder_names_and_paths[save_path][0][0]
        output_path = os.path.join(output_dir, filename)

        # Check if file already exists
        if os.path.exists(output_path):
            return web.json_response(
                {"error": f"File already exists: {output_path}"},
                status=400
            )

        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Mark as downloading
        download_id = f"{save_path}/{filename}"
        active_downloads[download_id] = {
            "url": url,
            "filename": filename,
            "save_path": save_path,
            "output_path": output_path,
            "progress": 0,
            "status": "downloading"
        }

        # Start download in background
        import asyncio
        asyncio.create_task(download_file(url, output_path, download_id))

        return web.json_response({
            "success": True,
            "download_id": download_id,
            "message": "Download started"
        })

    except Exception as e:
        logging.error(f"Error starting download: {e}")
        return web.json_response(
            {"error": str(e)},
            status=500
        )


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


async def download_file(url, output_path, download_id):
    """Download file with multi-connection support and progress tracking"""
    import aiohttp

    try:
        # Initialize control for this download
        download_control[download_id] = {
            "paused": False,
            "cancelled": False
        }

        timeout = aiohttp.ClientTimeout(total=None)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            # Get file size
            async with session.head(url) as response:
                if response.status not in [200, 302]:
                    raise Exception(f"HTTP {response.status}")

                total_size = int(response.headers.get('content-length', 0))
                supports_range = response.headers.get('accept-ranges') == 'bytes'

            if total_size == 0:
                raise Exception("Could not determine file size")

            # Create file with full size
            with open(output_path, 'wb') as f:
                f.seek(total_size - 1)
                f.write(b'\0')

            active_downloads[download_id]["total"] = total_size

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

    try:
        async with session.get(url, headers=headers) as response:
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
                    downloaded += len(chunk)

                    # Update progress (aggregate from all chunks)
                    if chunk_index == 0:  # Only send updates from first chunk to avoid spam
                        total_downloaded = start + downloaded
                        progress = (total_downloaded / total_size) * 100
                        active_downloads[download_id]["progress"] = progress
                        active_downloads[download_id]["downloaded"] = total_downloaded

                        await PromptServer.instance.send("server_download_progress", {
                            "download_id": download_id,
                            "progress": progress,
                            "downloaded": total_downloaded,
                            "total": total_size
                        })

    except Exception as e:
        logging.error(f"Error in chunk {chunk_index} for {download_id}: {e}")
        raise


async def download_single_connection(session, url, output_path, download_id, total_size):
    """Fallback single connection download"""
    downloaded_size = 0

    async with session.get(url) as response:
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

        download_control[download_id]["cancelled"] = True
        active_downloads[download_id]["status"] = "cancelled"

        await PromptServer.instance.send("server_download_cancelled", {
            "download_id": download_id
        })

        return web.json_response({"success": True, "message": "Download cancelled"})

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


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
__version__ = "1.0.0"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
