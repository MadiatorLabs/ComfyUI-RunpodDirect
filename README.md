# ComfyUI RunpodDirect

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![GitHub](https://img.shields.io/github/stars/MadiatorLabs/ComfyUI-RunpodDirect?style=social)](https://github.com/MadiatorLabs/ComfyUI-RunpodDirect)

Direct model downloads to your Runpod pod with blazing-fast multi-connection support. No more downloading models to your local machine and re-uploading!

## Features

- **Multi-Connection Downloads**: Up to 4x faster with parallel chunk downloading (4 connections per file)
- **Pause/Resume/Cancel**: Full control over active downloads
- **Download All Models**: Queue and download all missing models sequentially with one click
- **Real-Time Progress**: Live progress tracking with download speed, file size, and completion percentage

## Installation

1. Clone or download this repository into your ComfyUI `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/MadiatorLabs/ComfyUI-RunpodDirect.git
```

Or manually:
- Create a folder: `ComfyUI/custom_nodes/ComfyUI-RunpodDirect`
- Copy all files from this repository into that folder

2. Restart ComfyUI

3. **Hard refresh your browser** to load the new extension:
   - Windows/Linux: `Ctrl + Shift + R` or `Ctrl + F5`
   - Mac: `Cmd + Shift + R`
   - Or: Open DevTools (F12) → Right-click refresh → "Empty Cache and Hard Reload"

4. Verify the version loaded by checking the browser console (F12) for:
   ```
   [RunpodDirect] v1.0.0
   ```

## Usage

### Via Missing Models Dialog

1. Load a workflow that references missing models
2. When the "Missing Models" dialog appears, you'll see:
   - **Download All Models to Pod** button (downloads all models sequentially)
   - Individual buttons for each model:
     - **Download** (browser download - original functionality)
     - **Copy URL** (copy model URL - original functionality)
     - **Download to Pod** (NEW - downloads directly to server)

3. **Option A: Download All Models**
   - Click "Download All Models to Pod (X)" button
   - Watch the progress area showing:
     - Current file being downloaded
     - Overall progress (X/Y completed)
     - Download speed and file size
     - Pause/Resume/Cancel controls

4. **Option B: Download Individual Model**
   - Click "Download to Pod" button for a specific model
   - Button shows status with icons (spinner → checkmark/error)
   - Download happens in the background with multi-connection support

## Security

- Only allows downloads from whitelisted sources (as defined in ComfyUI's frontend)
- Downloads are saved to ComfyUI's model directories only
- Prevents overwriting existing files
- Validates all input parameters

## License

GNU General Public License v3.0 - See [LICENSE](LICENSE) for details.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue on [GitHub](https://github.com/MadiatorLabs/ComfyUI-RunpodDirect).

## Credits

Developed by [MadiatorLabs](https://github.com/MadiatorLabs)

## Support

If you find this useful, please ⭐ star the repo on [GitHub](https://github.com/MadiatorLabs/ComfyUI-RunpodDirect)!
