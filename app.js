// app.js (Entry Point - Main Thread)
import { vertexShaderSource, fragmentShaderSource } from './shaders.js';
// import MP4Box from './lib/mp4box.all.min.js'; // Cannot import - file missing

// --- DOM Elements ---
const videoInput = document.getElementById('videoInput');
const channelSelect = document.getElementById('channelSelect');
const processBtn = document.getElementById('processBtn');
// Removed original canvas declaration: const canvas = document.getElementById('processedCanvas');
const originalVideo = document.getElementById('originalVideo'); // Added
const statusBar = document.getElementById('statusBar');
const canvas = document.getElementById('processedCanvas'); // Declare canvas once, early
if (!canvas) { // Check canvas early
    console.error("Initialization Error: Canvas element not found!");
    // Attempt to show error, though statusBar might not be ready
    if (statusBar) statusBar.textContent = "Initialization Error: Canvas element not found!";
    else alert("Initialization Error: Canvas element not found!");
    throw new Error('Canvas element not found!'); // Stop execution
}
const gl = canvas.getContext('webgl'); // Initialize gl early

// --- State ---
let decoderWorker = null;
let frameQueue = [];
let currentFrameRequest = null;
let glProgram = null;
let positionLocation = null;
let texCoordLocation = null;
let textureLocation = null;
let channelLocation = null;
let positionBuffer = null;
let texCoordBuffer = null;
let videoTexture = null;
let webglInitialized = false;
let decodingFinished = false; // Track if worker signaled completion
let lastRenderedTimestamp = -1; // Track last rendered frame timestamp (microseconds)
let seeking = false; // Track if video is seeking
let currentObjectUrl = null; // To manage object URL lifecycle

// --- Check API Support ---
if (!window.Worker) {
  updateStatus('Error: Web Workers not supported.');
  throw new Error('Web Workers not supported.');
}
if (!gl) {
  updateStatus('Error: WebGL not supported.');
  throw new Error('WebGL not supported.');
}
if (!window.VideoDecoder) {
  updateStatus('Error: WebCodecs API not supported.');
  throw new Error('WebCodecs API not supported.');
}
// Check for FileReader API (though it's widely supported)
if (!window.FileReader) {
    updateStatus('Error: FileReader API not supported.');
    throw new Error('FileReader API not supported.');
}

// Wrap initialization in try...catch
try {
    // --- Get REMAINING DOM Elements ---
    // canvas and gl are already defined and checked
    // Ensure the duplicate declaration is truly gone
    const videoInput = document.getElementById('videoInput'); // Re-get elements inside try for safety? No, keep outside.
    const channelSelect = document.getElementById('channelSelect');
    const processBtn = document.getElementById('processBtn');
    const originalVideo = document.getElementById('originalVideo');
    // statusBar is already defined outside
    if (!videoInput || !channelSelect || !processBtn || !originalVideo || !statusBar) { // Removed canvas check here
        throw new Error('One or more essential UI elements not found!');
    }

    // --- Initialize Worker ---
    function initializeWorker() {
      // Ensure gl is accessible if needed inside worker setup, though it isn't currently
      // Create as a classic worker (remove type: 'module')
      decoderWorker = new Worker('./decoder_worker.js');
  decoderWorker.onmessage = handleWorkerMessage;
  decoderWorker.onerror = (err) => {
    console.error('Worker Error:', err);
    updateStatus(`Worker Error: ${err.message}`);
  };
}

// --- Event Listeners ---
videoInput.addEventListener('change', handleFileSelect);
processBtn.addEventListener('click', () => {
    processVideo();
    // Start the original video playback automatically after processing
    originalVideo.play().catch(err => {
        console.error('Error auto-playing video:', err);
        updateStatus('Error auto-playing video. Please play manually.');
    });
}); 
originalVideo.addEventListener('play', () => {
    updateStatus('Playback started.');
    if (!currentFrameRequest) startRenderingLoop(); // Resume rendering if paused
});
originalVideo.addEventListener('pause', () => {
    updateStatus('Playback paused.');
    // Render loop will continue running even when paused (modified in startRenderingLoop)
});
originalVideo.addEventListener('seeking', () => {
    updateStatus('Seeking...');
    seeking = true;
    // Clear queue? Or let render loop handle finding the right frame?
    // For simplicity, let render loop find the frame. Might cause jumpiness.
    // A better approach might involve signaling the worker to seek.
    lastRenderedTimestamp = -1; // Reset last rendered to force update
});
originalVideo.addEventListener('seeked', () => {
    updateStatus('Seek complete.');
    seeking = false;
    if (!currentFrameRequest) startRenderingLoop(); // Ensure rendering restarts if needed
});
originalVideo.addEventListener('error', (e) => {
    const error = originalVideo.error;
    let errorMessage = 'Unknown video error.';
    if (error) {
        // Use MediaError codes if available
        switch (error.code) {
            case MediaError.MEDIA_ERR_ABORTED:
                errorMessage = 'Video playback aborted.';
                break;
            case MediaError.MEDIA_ERR_NETWORK:
                errorMessage = 'A network error caused video download to fail.';
                break;
            case MediaError.MEDIA_ERR_DECODE:
                errorMessage = 'Video playback aborted due to a corruption problem or because the video used features your browser did not support.';
                break;
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                errorMessage = 'The video could not be loaded, either because the server or network failed or because the format is not supported.';
                break;
            default:
                errorMessage = `An unknown video error occurred (Code: ${error.code}).`;
                break;
        }
    }
    updateStatus(`Original Video Error: ${errorMessage}`);
    console.error('Original Video Error:', error);
});
originalVideo.addEventListener('loadedmetadata', () => {
    updateStatus(`Original video metadata loaded. Dimensions: ${originalVideo.videoWidth}x${originalVideo.videoHeight}`);
    console.log(`Original video dimensions: ${originalVideo.videoWidth}x${originalVideo.videoHeight}`);
});


// --- Functions ---
function updateStatus(message) {
  console.log('Status:', message);
  statusBar.textContent = message;
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Revoke previous object URL if it exists
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    originalVideo.removeAttribute('src'); // Clear video source
  }

  updateStatus(`Selected file: ${file.name}`);

  // Set source for original video playback
  currentObjectUrl = URL.createObjectURL(file);
  originalVideo.src = currentObjectUrl;
  originalVideo.load(); // Explicitly load the new source

  // DO NOT Trigger processing automatically anymore
  // processVideo(file);
  updateStatus('Video selected. Click "Process Video" to start analysis (currently disabled).');
}

// processVideo now accepts the file as an argument, or gets it from input
function processVideo(selectedFile = null) {
  const file = selectedFile || videoInput.files[0];
  if (!file) {
    updateStatus('No video file selected.');
    return;
  }
  
  // If we already have a worker, stop any ongoing processing
  if (decoderWorker) {
    updateStatus('Stopping previous processing...');
    try {
      // Send stop message to worker
      decoderWorker.postMessage({ type: 'stop' });
    } catch (e) {
      console.warn('Error stopping worker:', e);
    }
    // Terminate the old worker
    decoderWorker.terminate();
    decoderWorker = null;
  }
  
  // Create a new worker
  initializeWorker();
  
  updateStatus('Reading file...');
  // Reset state for new file
  frameQueue = [];
  decodingFinished = false;
  if (currentFrameRequest) {
      cancelAnimationFrame(currentFrameRequest);
      currentFrameRequest = null;
  }
  // Clear canvas and reset video state
  gl.clear(gl.COLOR_BUFFER_BIT);
  originalVideo.pause();
  // originalVideo.currentTime = 0; // Reset time? Maybe not needed if src is reset.
  lastRenderedTimestamp = -1;
  seeking = false;


    // Clone the buffer for the worker, keep original for potential re-read?
    // Or rely on the file object which should persist.
    // Let's assume the worker gets its own copy via postMessage transfer.
    file.arrayBuffer().then(buffer => {
    updateStatus('Sending file to worker for demuxing/decoding...');
    // Cannot pass MP4Box library as it's missing
    decoderWorker.postMessage({
        type: 'initialize',
        fileBuffer: buffer
        // mp4boxLib: MP4Box // Cannot pass
    }, [buffer]);
    // Setup WebGL here or wait for worker confirmation
    setupWebGL();
  }).catch(err => {
    updateStatus(`Error reading file: ${err.message}`);
  });
}

function handleWorkerMessage(event) {
  const { type, data } = event.data;
  switch (type) {
    case 'status':
      updateStatus(`Worker: ${data.message}`);
      break;
    case 'trackInfo':
      // Handle track info (dimensions, etc.), maybe resize canvas
      console.log('Track Info:', data);
      canvas.width = data.codedWidth;
      canvas.height = data.codedHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      break;
    case 'newFrame':
      console.log(`Main: Received new frame from worker, timestamp: ${data.timestamp}`);
      
      // Add received VideoFrame with its timestamp to the queue
      frameQueue.push({ frame: data.frame, timestamp: data.frame.timestamp });
      // Keep queue sorted by timestamp (important for efficient searching)
      frameQueue.sort((a, b) => a.timestamp - b.timestamp);
      
      console.log(`Main: Frame queue size: ${frameQueue.length}`);

      // Ensure rendering loop is running if video is playing or seeking
      if (!currentFrameRequest && (!originalVideo.paused || seeking)) {
          console.log("Main: Starting render loop due to new frame");
          startRenderingLoop();
      }
      break;
    case 'error':
      updateStatus(`Worker Error: ${data.message}`);
      // Stop processing?
      break;
    case 'decodeComplete':
        updateStatus('Worker finished decoding.');
        decodingFinished = true;
        // The render loop will stop itself when the queue is empty
        break;
    default:
      console.warn('Unknown message from worker:', event.data);
  }
}

function setupWebGL() {
  if (webglInitialized) return;
  updateStatus('Setting up WebGL...');

  // --- Compile Shaders ---
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return; // Error handled in createShader

  // --- Link Program ---
  glProgram = createProgram(gl, vertexShader, fragmentShader);
  if (!glProgram) return; // Error handled in createProgram
  gl.useProgram(glProgram);

  // --- Get Attribute & Uniform Locations ---
  positionLocation = gl.getAttribLocation(glProgram, 'a_position');
  texCoordLocation = gl.getAttribLocation(glProgram, 'a_texCoord');
  textureLocation = gl.getUniformLocation(glProgram, 'u_texture');
  channelLocation = gl.getUniformLocation(glProgram, 'u_channel');

  // --- Create Buffers for Quad ---
  // Positions (covers entire clip space)
  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, // bottom left
     1, -1, // bottom right
    -1,  1, // top left
     1,  1, // top right
  ]), gl.STATIC_DRAW);

  // Texture Coordinates (maps texture to quad)
  texCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, // bottom left
    1, 0, // bottom right
    0, 1, // top left
    1, 1, // top right
  ]), gl.STATIC_DRAW);

  // --- Create Texture ---
  videoTexture = createTexture(gl);

  // --- Configure Attributes ---
  gl.enableVertexAttribArray(positionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(texCoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

  // --- Initial GL State ---
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height); // Set initial viewport
  gl.clearColor(0.1, 0.1, 0.1, 1); // Dark background
  gl.uniform1i(textureLocation, 0); // Use texture unit 0

  updateStatus('WebGL setup complete.');
  webglInitialized = true;
}

// --- WebGL Helper Functions ---
function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (success) {
    return shader;
  }
  const errorLog = gl.getShaderInfoLog(shader);
  updateStatus(`Shader Compile Error (${type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'}): ${errorLog}`);
  console.error('Shader Compile Error:', errorLog);
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  const success = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (success) {
    return program;
  }
  const errorLog = gl.getProgramInfoLog(program);
  updateStatus(`Program Link Error: ${errorLog}`);
  console.error('Program Link Error:', errorLog);
  gl.deleteProgram(program);
  return null;
}

function createTexture(gl) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Basic texture settings - might need adjustment
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // or NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); // or NEAREST

    // Placeholder pixel until first frame arrives
    const level = 0;
    const internalFormat = gl.RGBA;
    const width = 1;
    const height = 1;
    const border = 0;
    const srcFormat = gl.RGBA;
    const srcType = gl.UNSIGNED_BYTE;
    const pixel = new Uint8Array([0, 0, 0, 255]); // Black
    gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, width, height, border, srcFormat, srcType, pixel);

    return texture;
}


function startRenderingLoop() {
  if (currentFrameRequest) {
      // console.log("Render loop already running.");
      return; // Already running
  }
  updateStatus("Starting render loop...");

  function renderLoop() {
      // Always keep the render loop running while the original video is playing
      // Only stop if paused, queue empty, and decoding finished
      if (originalVideo.paused && frameQueue.length === 0 && decodingFinished) {
          updateStatus('Playback paused and queue empty. Stopping render loop.');
          currentFrameRequest = null;
          return;
      }

      let frameToRender = null;
      let frameIndex = -1;
      const videoTimeMicro = originalVideo.currentTime * 1_000_000;

      // Find the best frame to render based on video's current time
      for (let i = frameQueue.length - 1; i >= 0; i--) {
          if (frameQueue[i].timestamp <= videoTimeMicro) {
              // This is the latest frame that's not in the future
              // Only render if it's newer than the last rendered frame or if seeking
              if (seeking || frameQueue[i].timestamp > lastRenderedTimestamp) {
                  frameToRender = frameQueue[i].frame;
                  frameIndex = i;
              }
              // Since queue is sorted, we can stop searching
              break;
          }
      }

      if (frameToRender) {
          if (!webglInitialized || !glProgram) {
              console.warn("WebGL not ready for rendering.");
              // Don't close the frame yet, try again next loop
          } else {
              // --- Render the selected frame ---
              console.log(`Main: Rendering frame ${frameToRender.timestamp} for video time ${videoTimeMicro}`);
              
              try {
                  gl.activeTexture(gl.TEXTURE0);
                  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                  
                  // Log frame details before rendering
                  console.log(`Main: Frame details - type: ${frameToRender.type}, format: ${frameToRender.format}, size: ${frameToRender.codedWidth}x${frameToRender.codedHeight}`);
                  
                  // Check if we need to resize the canvas to match the frame
                  if (canvas.width !== frameToRender.codedWidth || canvas.height !== frameToRender.codedHeight) {
                      console.log(`Main: Resizing canvas to match frame: ${frameToRender.codedWidth}x${frameToRender.codedHeight}`);
                      canvas.width = frameToRender.codedWidth;
                      canvas.height = frameToRender.codedHeight;
                      gl.viewport(0, 0, canvas.width, canvas.height);
                  }
                  
                  // Try different approaches to render the VideoFrame to WebGL
                  try {
                    // Approach 1: Try to use the VideoFrame directly with WebGL
                    // This might work in some browsers but fail in others
                    try {
                      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameToRender);
                      console.log("Main: Successfully used VideoFrame directly with WebGL");
                    } catch (directError) {
                      console.log("Main: Could not use VideoFrame directly with WebGL, trying canvas approach");
                      
                      // Approach 2: Create a temporary canvas to convert the VideoFrame
                      const tempCanvas = document.createElement('canvas');
                      tempCanvas.width = frameToRender.codedWidth;
                      tempCanvas.height = frameToRender.codedHeight;
                      const tempCtx = tempCanvas.getContext('2d');
                      
                      // Draw the VideoFrame to the temporary canvas
                      tempCtx.drawImage(frameToRender, 0, 0);
                      
                      // Now use the temporary canvas as the source for the WebGL texture
                      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tempCanvas);
                      console.log("Main: Successfully used canvas approach for VideoFrame");
                    }
                  } catch (error) {
                    console.error("Main: All VideoFrame rendering approaches failed:", error);
                    throw error; // Re-throw to be caught by the outer try/catch
                  }
                  
                  // Set the selected CMYK channel
                  const selectedChannel = parseInt(channelSelect.value, 10);
                  console.log(`Main: Selected CMYK channel: ${selectedChannel}`);
                  gl.uniform1i(channelLocation, selectedChannel);
                  
                  // Clear and draw
                  gl.clear(gl.COLOR_BUFFER_BIT);
                  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                  
                  console.log(`Main: Frame rendered successfully`);
                  
                  lastRenderedTimestamp = frameToRender.timestamp;
                  
                  // --- Clean up queue ---
                  // Close the rendered frame and any older frames
                  for (let i = 0; i <= frameIndex; i++) {
                      try {
                          frameQueue[i].frame.close();
                      } catch (e) {
                          console.warn(`Main: Error closing frame: ${e.message}`);
                      }
                  }
                  // Remove the closed frames from the queue
                  frameQueue.splice(0, frameIndex + 1);
                  console.log(`Main: Queue cleaned up, new size: ${frameQueue.length}`);
              } catch (error) {
                  console.error(`Main: Error rendering frame: ${error.message}`);
                  console.error(error.stack);
                  
                  // If we encounter an error with this frame, close it and remove it from the queue
                  if (frameIndex >= 0) {
                      try {
                          frameQueue[frameIndex].frame.close();
                          frameQueue.splice(frameIndex, 1);
                      } catch (e) {
                          console.warn(`Main: Error cleaning up after render failure: ${e.message}`);
                      }
                  }
              }
          }
      } else {
          // console.log(`No suitable frame found for video time ${videoTimeMicro}. Queue size: ${frameQueue.length}`);
          // If seeking, might want to clear canvas to avoid showing stale frame
          if (seeking) {
             gl.clear(gl.COLOR_BUFFER_BIT);
          }
      }

      // --- Request next frame ---
      // Always keep the render loop running while the original video is playing
      currentFrameRequest = requestAnimationFrame(renderLoop);
  }

  // Start the loop
  currentFrameRequest = requestAnimationFrame(renderLoop);
}


    // --- Initial Status ---
    updateStatus('Ready. Select a video file.');

} catch (error) { // Add catch block
    console.error("Initialization Error:", error);
    // Try to update status bar if possible, otherwise alert
    const statusBarElem = document.getElementById('statusBar'); // Use different var name
    if (statusBarElem) {
        statusBarElem.textContent = `Initialization Error: ${error.message}`;
        statusBarElem.style.color = 'red';
    } else {
        // Fallback if status bar itself is missing
        alert(`Initialization Error: ${error.message}`);
    }
}
// Ensure module usage allows top-level await if needed, or wrap in async function
