// decoder_worker.js
console.log("Worker script started."); // Log entry point

// Import demuxer library (e.g., mp4box.js)
importScripts('./lib/mp4box.all.min.js'); // Updated path to lib directory

/**
 * @typedef {Object} TrackInfo
 * @property {string} codec - The codec string (e.g., 'avc1.42E01E')
 * @property {number} codedWidth - The width of the video in pixels
 * @property {number} codedHeight - The height of the video in pixels
 * @property {Uint8Array} [description] - Optional codec-specific description data
 */

// Global state
let videoDecoder = null;
let mp4boxfile = null;
let videoTrack = null;
let isProcessingComplete = false; // Flag to track if processing is complete
let lastSampleTime = 0; // Track the time of the last sample received
let sampleCount = 0; // Count of samples received
let abortController = null; // For explicit resource cleanup

// Structured logging levels
const LogLevel = {
  INFO: 'info',
  ERROR: 'error',
  WARNING: 'warning',
  DEBUG: 'debug'
};

self.onmessage = async (event) => {
  const { type, fileBuffer } = event.data;

  if (type === 'stop') {
    // Handle explicit stop request from main thread
    log(LogLevel.INFO, 'Received stop command from main thread');
    if (!isProcessingComplete) {
      isProcessingComplete = true;
      await closeDecoder();
    }
    return;
  }
  
  if (type === 'initialize') {
    log(LogLevel.INFO, 'Worker received file. Initializing demuxer...');

    // Reset state for new processing
    isProcessingComplete = false;
    lastSampleTime = Date.now(); // Reset to current time
    sampleCount = 0;

    // Create a new abort controller for this processing session
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    // Reset existing demuxer if it exists
    if (mp4boxfile) {
      log(LogLevel.INFO, 'Resetting existing demuxer');
      // Ensure previous decoding is finished
      if (videoDecoder && videoDecoder.state !== 'closed') {
        await closeDecoder();
      } else {
        // Ensure decoder is null even if it was already closed
        videoDecoder = null;
      }
      mp4boxfile.stop();
      mp4boxfile = null;
      videoTrack = null;
    }

    try {
      // --- Demuxer Initialization (mp4box.js) ---
      // Check if MP4Box is defined
      if (typeof MP4Box === 'undefined') {
        throw new Error('MP4Box library not loaded. Check the import path.');
      }
      
      mp4boxfile = MP4Box.createFile(); // Create file after verifying MP4Box exists

      // --- Start of mp4box logic ---
      mp4boxfile.onReady = (info) => {
        log(LogLevel.INFO, 'Demuxer ready');
        videoTrack = info.videoTracks[0]; // Assume first video track
        if (!videoTrack) {
          log(LogLevel.ERROR, 'No video track found in the file');
          return;
        }

        const trackInfo = {
          codec: videoTrack.codec, // e.g., 'avc1.42E01E'
          codedWidth: videoTrack.track_width,
          codedHeight: videoTrack.track_height,
          description: extractAvccDescription(videoTrack) // Needs specific logic
        };
        self.postMessage({ type: 'trackInfo', data: trackInfo });

        // Initialize decoder
        initializeDecoder(trackInfo);

        // Configure extraction - removed nbSamples to allow full processing
        mp4boxfile.setExtractionOptions(videoTrack.id, null, {});
        log(LogLevel.INFO, 'Starting demuxing...');
        mp4boxfile.start();
      };

      mp4boxfile.onError = (error) => {
        log(LogLevel.ERROR, `Demuxer error: ${error}`);
      };

      // Add an onComplete handler to detect end of file
      mp4boxfile.onComplete = () => {
        log(LogLevel.INFO, 'MP4Box processing complete');
        // Signal that we've reached the end of the file
        if (!isProcessingComplete) {
          // Wait a bit to ensure all samples have been processed
          setTimeout(() => {
            if (!isProcessingComplete) {
              isProcessingComplete = true;
              closeDecoder();
            }
          }, 1000);
        }
      };

      mp4boxfile.onSamples = (track_id, user, samples) => {
        // This callback receives the raw encoded samples (chunks)
        if (track_id !== videoTrack.id) return;
        
        log(LogLevel.DEBUG, `Received ${samples.length} samples for track ${track_id}`);
        
        // Update sample tracking for decoder lifecycle management
        lastSampleTime = Date.now();
        sampleCount += samples.length;
        
        // Keep track of samples for debugging
        let processedSamples = 0;
        let errorSamples = 0;
        
        // Process each sample with yield points for large batches
        processSamplesBatch(samples, 0, processedSamples, errorSamples);
      };

      // Append the received buffer
      log(LogLevel.INFO, 'Appending buffer to demuxer...');
      // Create a copy of the buffer to avoid direct modification
      const buffer = fileBuffer.slice(0);
      buffer.fileStart = 0; // Required property by mp4box.js
      mp4boxfile.appendBuffer(buffer);
      log(LogLevel.INFO, 'Buffer appended. Flushing demuxer...');
      mp4boxfile.flush(); // Signal end of initial buffer

      // Set up a check that periodically looks for inactivity
      // but doesn't automatically close the decoder after a fixed time
      const checkInterval = setInterval(() => {
        if (signal.aborted) {
          clearInterval(checkInterval);
          return;
        }

        const now = Date.now();
        const timeSinceLastSample = now - lastSampleTime;
        
        // If we haven't received any samples in a while and we've processed at least some samples,
        // we can assume processing is complete
        if (timeSinceLastSample > 5000 && sampleCount > 0) {
          log(LogLevel.INFO, 'No new samples received for 5 seconds. Processing appears complete.');
          clearInterval(checkInterval);
          
          // Only close if we're not still actively processing
          if (!isProcessingComplete) {
            isProcessingComplete = true;
            closeDecoder();
          }
        }
      }, 1000); // Check every second

      // Add event listener for abort signal
      signal.addEventListener('abort', () => {
        log(LogLevel.INFO, 'Processing aborted');
        clearInterval(checkInterval);
        if (!isProcessingComplete) {
          isProcessingComplete = true;
          closeDecoder();
        }
      });

    } catch (err) {
      log(LogLevel.ERROR, `Demuxer initialization failed: ${err.message}`);
      await closeDecoder(); // Also try to close decoder on init error
    }
  }
};

/**
 * Process samples in batches to avoid blocking the thread
 * @param {Array} samples - Array of samples to process
 * @param {number} startIndex - Starting index in the samples array
 * @param {number} processedCount - Running count of processed samples
 * @param {number} errorCount - Running count of error samples
 */
function processSamplesBatch(samples, startIndex, processedCount, errorCount) {
  const BATCH_SIZE = 10; // Process 10 samples at a time
  const endIndex = Math.min(startIndex + BATCH_SIZE, samples.length);
  
  // Check if decoder is ready before processing batch
  if (!videoDecoder || videoDecoder.state !== 'configured') {
    // Try to initialize decoder if it's not ready
    if (videoTrack) {
      log(LogLevel.INFO, "Decoder not ready before batch processing, initializing...");
      const trackInfo = {
        codec: videoTrack.codec,
        codedWidth: videoTrack.track_width,
        codedHeight: videoTrack.track_height,
        description: extractAvccDescription(videoTrack)
      };
      
      // Initialize decoder and wait for it to be ready
      initializeDecoder(trackInfo).then(() => {
        // Once decoder is ready, retry processing this batch
        if (videoDecoder && videoDecoder.state === 'configured') {
          log(LogLevel.INFO, "Decoder initialized, retrying batch");
          processSamplesBatch(samples, startIndex, processedCount, errorCount);
        } else {
          log(LogLevel.ERROR, "Failed to initialize decoder, skipping batch");
          // Schedule next batch if there are more samples
          if (endIndex < samples.length) {
            setTimeout(() => {
              processSamplesBatch(samples, endIndex, processedCount, errorCount);
            }, 0);
          }
        }
      });
      return; // Exit this function call, will retry after initialization
    } else {
      log(LogLevel.ERROR, "Cannot initialize decoder: videoTrack is not available");
      // Continue processing to log errors for each sample
    }
  }
  
  for (let i = startIndex; i < endIndex; i++) {
    try {
      const sample = samples[i];
      // Log sample details for debugging
      const isKeyFrame = sample.is_sync;
      const timestamp = sample.cts * (1_000_000 / videoTrack.timescale);
      const duration = sample.duration * (1_000_000 / videoTrack.timescale);
      
      log(LogLevel.DEBUG, `Processing sample - keyframe: ${isKeyFrame}, timestamp: ${timestamp}, size: ${sample.data.byteLength}`);
      
      // Create the encoded chunk
      const chunk = new EncodedVideoChunk({
        type: isKeyFrame ? 'key' : 'delta',
        timestamp: timestamp, // Microseconds
        duration: duration, // Microseconds
        data: sample.data
      });
      
      // Queue the chunk for the decoder
      if (videoDecoder && videoDecoder.state === 'configured') {
        try {
          videoDecoder.decode(chunk);
          processedCount++;
        } catch (e) {
          errorCount++;
          log(LogLevel.ERROR, `Decoder decode error: ${e.message}`);
          
          // If we encounter too many errors, we might want to try a different approach
          if (errorCount > 5) {
            log(LogLevel.ERROR, "Too many decode errors, trying to reset decoder...");
            // Reset the decoder
            resetDecoder(videoTrack);
          }
        }
      } else {
        log(LogLevel.WARNING, `Decoder not ready (state: ${videoDecoder ? videoDecoder.state : 'null'}), sample dropped`);
        errorCount++;
      }
    } catch (e) {
      errorCount++;
      log(LogLevel.ERROR, `Error processing sample: ${e.message}`);
    }
  }
  
  log(LogLevel.DEBUG, `Processed ${processedCount}/${samples.length} samples, ${errorCount} errors`);
  
  // If there are more samples to process, schedule the next batch
  if (endIndex < samples.length) {
    setTimeout(() => {
      processSamplesBatch(samples, endIndex, processedCount, errorCount);
    }, 0); // Yield to the event loop
  }
}

/**
 * Initialize the video decoder with the appropriate configuration
 * @param {TrackInfo} trackInfo - Information about the video track
 */
async function initializeDecoder(trackInfo) {
  log(LogLevel.INFO, `Initializing decoder for codec: ${trackInfo.codec}`);

  // Log detailed codec information
  log(LogLevel.DEBUG, `Codec details - codec: ${trackInfo.codec}, width: ${trackInfo.codedWidth}, height: ${trackInfo.codedHeight}`);
  if (trackInfo.description) {
    log(LogLevel.DEBUG, `Description buffer length: ${trackInfo.description.byteLength}`);
  } else {
    log(LogLevel.DEBUG, `No codec description available`);
  }

  try {
    // Close existing decoder if it's still around
    if (videoDecoder) {
      try {
        if (videoDecoder.state !== 'closed') {
          videoDecoder.close();
        }
        videoDecoder = null;
      } catch (e) {
        log(LogLevel.WARNING, `Error closing existing decoder: ${e.message}`);
      }
    }
    
    // For AVC/H.264, preserve the full codec string and description
    let configToUse = {
      codec: trackInfo.codec,
      codedWidth: trackInfo.codedWidth,
      codedHeight: trackInfo.codedHeight
    };
    
    // Add description if available
    if (trackInfo.description) {
      configToUse.description = trackInfo.description;
    }
    
    // Validate codec support
    const support = await VideoDecoder.isConfigSupported(configToUse);
    log(LogLevel.INFO, `Codec support for ${trackInfo.codec}: ${support.supported}`);
    
    if (!support.supported) {
      // If not supported, try without description
      const basicConfig = {
        codec: trackInfo.codec,
        codedWidth: trackInfo.codedWidth,
        codedHeight: trackInfo.codedHeight
      };
      
      const basicSupport = await VideoDecoder.isConfigSupported(basicConfig);
      log(LogLevel.INFO, `Basic codec support (without description): ${basicSupport.supported}`);
      
      if (basicSupport.supported) {
        configToUse = basicConfig;
      } else {
        log(LogLevel.ERROR, `No supported decoder configuration found for this video`);
        return;
      }
    }
    
    log(LogLevel.INFO, `Using decoder config: ${JSON.stringify(configToUse)}`);
    
    videoDecoder = new VideoDecoder({
      output: handleFrame,
      error: handleError,
    });

    await videoDecoder.configure(configToUse);
    log(LogLevel.INFO, 'Decoder configured successfully');

  } catch (err) {
    log(LogLevel.ERROR, `Decoder initialization failed: ${err.message}`);
    videoDecoder = null; // Reset decoder on failure
  }
}

/**
 * Reset the decoder by closing and reinitializing it
 * @param {Object} track - The video track information
 */
async function resetDecoder(track) {
  if (!track) {
    log(LogLevel.ERROR, "Cannot reset decoder: track information not available");
    return;
  }
  
  log(LogLevel.INFO, "Resetting decoder...");
  
  try {
    // Close the existing decoder if it exists
    if (videoDecoder) {
      try {
        if (videoDecoder.state !== 'closed') {
          videoDecoder.close();
        }
      } catch (e) {
        log(LogLevel.WARNING, `Error closing decoder during reset: ${e.message}`);
      }
      videoDecoder = null;
    }
    
    // Reinitialize with the same track info
    const trackInfo = {
      codec: track.codec,
      codedWidth: track.track_width,
      codedHeight: track.track_height,
      description: extractAvccDescription(track)
    };
    
    await initializeDecoder(trackInfo);
    log(LogLevel.INFO, "Decoder reset complete");
    
  } catch (err) {
    log(LogLevel.ERROR, `Decoder reset failed: ${err.message}`);
  }
}

/**
 * Handle a decoded video frame
 * @param {VideoFrame} frame - The decoded video frame
 */
function handleFrame(frame) {
  // Log frame details for debugging
  log(LogLevel.DEBUG, `Decoded frame received, timestamp: ${frame.timestamp}, size: ${frame.codedWidth}x${frame.codedHeight}`);
  
  // Transfer frame ownership to main thread
  self.postMessage({ 
    type: 'newFrame', 
    data: { 
      frame: frame,
      timestamp: frame.timestamp 
    }
  }, [frame]);
}

/**
 * Handle decoder errors
 * @param {DOMException} error - The decoder error
 */
function handleError(error) {
  log(LogLevel.ERROR, `Decoder error: ${error.message}`);
}

/**
 * Structured logging function
 * @param {string} level - Log level (info, error, warning, debug)
 * @param {string} message - Log message
 */
function log(level, message) {
  // Always log to console with appropriate level
  switch (level) {
    case LogLevel.ERROR:
      console.error(`Worker: ${message}`);
      break;
    case LogLevel.WARNING:
      console.warn(`Worker: ${message}`);
      break;
    case LogLevel.DEBUG:
      console.log(`Worker: ${message}`);
      break;
    case LogLevel.INFO:
    default:
      console.log(`Worker: ${message}`);
      break;
  }
  
  // Only send info and error messages to the main thread
  if (level === LogLevel.INFO) {
    self.postMessage({ type: 'status', data: { message } });
  } else if (level === LogLevel.ERROR) {
    self.postMessage({ type: 'error', data: { message } });
  }
}

/**
 * Extract AVCC description for H.264/AVC
 * @param {Object} track - The video track
 * @returns {Uint8Array|undefined} - The AVCC description data or undefined
 */
function extractAvccDescription(track) {
  if (!mp4boxfile || !track) {
    log(LogLevel.WARNING, "MP4Box or track not available for description extraction");
    return undefined;
  }
  
  try {
    // For AVC/H.264, we need the avcC box data for proper decoding
    if (track.codec.startsWith('avc1.')) {
      log(LogLevel.DEBUG, `Using codec string for description: ${track.codec}`);
      
      // Get the actual avcC box data
      const trak = mp4boxfile.getTrackById(track.id);
      if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl || !trak.mdia.minf.stbl.stsd) {
        log(LogLevel.WARNING, "Could not find stsd box for track description");
        return undefined;
      }
      
      for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        // Check for avc1, avc3, etc.
        if (entry.avcC) {
          log(LogLevel.DEBUG, "Found avcC box, extracting description");
          
          // Try to get the avcC data directly
          if (entry.avcC.data) {
            log(LogLevel.DEBUG, "Using avcC.data directly");
            return entry.avcC.data;
          }
          
          // If no direct data access, try serializing
          const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
          entry.avcC.write(stream);
          log(LogLevel.DEBUG, `Serialized avcC box, buffer size: ${stream.buffer.byteLength}`);
          
          // Return the full avcC data
          return new Uint8Array(stream.buffer);
        }
      }
      
      log(LogLevel.WARNING, "avcC box not found for track description");
    }
    
    return undefined;
    
  } catch (error) {
    log(LogLevel.ERROR, `Error extracting codec description: ${error.message}`);
    return undefined;
  }
}

/**
 * Handle decoder flushing/closing when demuxing is complete or on error/reset
 */
async function closeDecoder() {
   if (videoDecoder && videoDecoder.state !== 'closed') {
       try {
           log(LogLevel.INFO, 'Flushing decoder...');
           await videoDecoder.flush();
           videoDecoder.close();
           log(LogLevel.INFO, 'Decoder flushed and closed.');
       } catch (e) {
           log(LogLevel.ERROR, `Error flushing/closing decoder: ${e.message}`);
       }
   }
   
   // Clean up resources
   if (abortController) {
     abortController.abort();
     abortController = null;
   }
   
   // Signal completion
   self.postMessage({ type: 'decodeComplete' });
   videoDecoder = null; // Ensure decoder is nullified
}
