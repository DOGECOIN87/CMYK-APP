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
let keyframeReceived = false; // Track if we've received a keyframe
let decoderResetAttempts = 0; // Track number of decoder reset attempts
let processingId = Date.now(); // Correlation ID for tracing processing sessions
let checkIntervals = []; // Track all interval IDs for proper cleanup

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
    log(LogLevel.INFO, `[${processingId}] Received stop command from main thread`);
    if (!isProcessingComplete) {
      isProcessingComplete = true;
      await closeDecoder();
    }
    return;
  }
  
  if (type === 'initialize') {
    processingId = Date.now(); // Generate new correlation ID for this processing session
    log(LogLevel.INFO, `[${processingId}] Worker received file. Initializing demuxer...`);

    // Reset state for new processing
    isProcessingComplete = false;
    lastSampleTime = Date.now(); // Reset to current time
    sampleCount = 0;
    keyframeReceived = false; // Reset keyframe tracking
    decoderResetAttempts = 0; // Reset decoder reset attempts counter

    // Clean up any existing intervals
    checkIntervals.forEach(intervalId => clearInterval(intervalId));
    checkIntervals = [];
    
    // Create a new abort controller for this processing session
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    // Reset existing demuxer if it exists
    if (mp4boxfile) {
      log(LogLevel.INFO, `[${processingId}] Resetting existing demuxer`);
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
        log(LogLevel.INFO, `[${processingId}] Demuxer ready`);
        videoTrack = info.videoTracks[0]; // Assume first video track
        if (!videoTrack) {
          log(LogLevel.ERROR, `[${processingId}] No video track found in the file`);
          return;
        }

        const trackInfo = {
          codec: videoTrack.codec, // e.g., 'avc1.42E01E'
          codedWidth: videoTrack.track_width,
          codedHeight: videoTrack.track_height,
          description: extractCodecDescription(videoTrack) // Updated to handle multiple codecs
        };
        self.postMessage({ type: 'trackInfo', data: trackInfo });

        // Initialize decoder
        initializeDecoder(trackInfo);

        // Configure extraction - removed nbSamples to allow full processing
        mp4boxfile.setExtractionOptions(videoTrack.id, null, {});
        log(LogLevel.INFO, `[${processingId}] Starting demuxing...`);
        mp4boxfile.start();
      };

      mp4boxfile.onError = (error) => {
        log(LogLevel.ERROR, `[${processingId}] Demuxer error: ${error}`);
      };

      // Add an onComplete handler to detect end of file
      mp4boxfile.onComplete = () => {
        log(LogLevel.INFO, `[${processingId}] MP4Box processing complete`);
        // Signal that we've reached the end of the file
        if (!isProcessingComplete) {
          // Wait a bit to ensure all samples have been processed
          setTimeout(async () => {
            if (!isProcessingComplete) {
              isProcessingComplete = true;
              await closeDecoder();
            }
          }, 1000);
        }
      };

      mp4boxfile.onSamples = (track_id, user, samples) => {
        // This callback receives the raw encoded samples (chunks)
        if (track_id !== videoTrack.id) return;
        
        log(LogLevel.DEBUG, `[${processingId}] Received ${samples.length} samples for track ${track_id}`);
        
        // Count keyframes for debugging
        const keyframeCount = samples.filter(s => s.is_sync).length;
        log(LogLevel.INFO, `[${processingId}] Batch contains ${keyframeCount} keyframes out of ${samples.length} samples`);
        
        // Update sample tracking for decoder lifecycle management
        lastSampleTime = Date.now();
        sampleCount += samples.length;
        
        // Keep track of samples for debugging
        let processedSamples = 0;
        let errorSamples = 0;
        
        // Process each sample with yield points for large batches
        // We need to call this asynchronously since we can't await in this callback
        setTimeout(async () => {
          await processSamplesBatch(samples, 0, processedSamples, errorSamples);
        }, 0);
      };

      // Append the received buffer
      log(LogLevel.INFO, `[${processingId}] Appending buffer to demuxer...`);
      // Create a copy of the buffer to avoid direct modification
      const buffer = fileBuffer.slice(0);
      buffer.fileStart = 0; // Required property by mp4box.js
      mp4boxfile.appendBuffer(buffer);
      log(LogLevel.INFO, `[${processingId}] Buffer appended. Flushing demuxer...`);
      mp4boxfile.flush(); // Signal end of initial buffer

      // Set up a check that periodically looks for inactivity
      // but doesn't automatically close the decoder after a fixed time
      const checkInterval = setInterval(() => {
        if (signal.aborted) {
          clearInterval(checkInterval);
          const intervalIndex = checkIntervals.indexOf(checkInterval);
          if (intervalIndex !== -1) {
            checkIntervals.splice(intervalIndex, 1);
          }
          return;
        }

        const now = Date.now();
        const timeSinceLastSample = now - lastSampleTime;
        
        // If we haven't received any samples in a while and we've processed at least some samples,
        // we can assume processing is complete
        if (timeSinceLastSample > 5000 && sampleCount > 0) {
          log(LogLevel.INFO, `[${processingId}] No new samples received for 5 seconds. Processing appears complete.`);
          clearInterval(checkInterval);
          const intervalIndex = checkIntervals.indexOf(checkInterval);
          if (intervalIndex !== -1) {
            checkIntervals.splice(intervalIndex, 1);
          }
          
          // Only close if we're not still actively processing
          if (!isProcessingComplete) {
            isProcessingComplete = true;
            (async () => {
              await closeDecoder();
            })();
          }
        }
      }, 1000); // Check every second
      
      // Add to our list of intervals for cleanup
      checkIntervals.push(checkInterval);

      // Add event listener for abort signal
      signal.addEventListener('abort', () => {
        log(LogLevel.INFO, `[${processingId}] Processing aborted`);
        
        // Clear all intervals
        checkIntervals.forEach(intervalId => clearInterval(intervalId));
        checkIntervals = [];
        
        if (!isProcessingComplete) {
          isProcessingComplete = true;
          (async () => {
            await closeDecoder();
          })();
        }
      });

    } catch (err) {
      log(LogLevel.ERROR, `[${processingId}] Demuxer initialization failed: ${err.message}`);
      await closeDecoder(); // Also try to close decoder on init error
    }
  }
};

/**
 * Calculate optimal batch size based on video resolution and system capabilities
 * @param {Object} track - The video track information
 * @returns {number} - The optimal batch size
 */
function calculateOptimalBatchSize(track) {
  if (!track) return 10; // Default if no track info
  
  // Base calculation on video resolution
  const pixelCount = track.track_width * track.track_height;
  
  // Adjust batch size inversely with resolution
  // Higher resolution = smaller batches to avoid overwhelming the decoder
  if (pixelCount > 2073600) { // > 1080p (1920x1080)
    return 5;
  } else if (pixelCount > 921600) { // > 720p (1280x720)
    return 10;
  } else if (pixelCount > 307200) { // > 480p (640x480)
    return 15;
  } else {
    return 20; // Small videos can process more frames at once
  }
}

/**
 * Process samples in batches to avoid blocking the thread
 * @param {Array} samples - Array of samples to process
 * @param {number} startIndex - Starting index in the samples array
 * @param {number} processedCount - Running count of processed samples
 * @param {number} errorCount - Running count of error samples
 */
async function processSamplesBatch(samples, startIndex, processedCount, errorCount) {
  const batchSize = calculateOptimalBatchSize(videoTrack);
  const endIndex = Math.min(startIndex + batchSize, samples.length);
  
  log(LogLevel.DEBUG, `[${processingId}] Processing batch with size ${batchSize}, samples ${startIndex}-${endIndex-1} of ${samples.length}`);
  
  // Check if decoder is ready before processing batch
  if (!videoDecoder || videoDecoder.state !== 'configured') {
    // Try to initialize decoder if it's not ready
    if (videoTrack) {
      log(LogLevel.INFO, `[${processingId}] Decoder not ready before batch processing, initializing...`);
      const trackInfo = {
        codec: videoTrack.codec,
        codedWidth: videoTrack.track_width,
        codedHeight: videoTrack.track_height,
        description: extractCodecDescription(videoTrack)
      };
      
      try {
        // Initialize decoder and wait for it to be ready
        await initializeDecoder(trackInfo);
        
        // Check if decoder is now ready
        if (videoDecoder && videoDecoder.state === 'configured') {
          log(LogLevel.INFO, `[${processingId}] Decoder initialized, retrying batch`);
          await processSamplesBatch(samples, startIndex, processedCount, errorCount);
        } else {
          log(LogLevel.ERROR, `[${processingId}] Failed to initialize decoder, skipping batch`);
        // Schedule next batch if there are more samples
        if (endIndex < samples.length) {
          setTimeout(async () => {
            await processSamplesBatch(samples, endIndex, processedCount, errorCount);
          }, 0); // Yield to the event loop
        }
        }
      } catch (error) {
        log(LogLevel.ERROR, `[${processingId}] Error initializing decoder: ${error.message}`);
        // Schedule next batch if there are more samples
        if (endIndex < samples.length) {
          setTimeout(async () => {
            await processSamplesBatch(samples, endIndex, processedCount, errorCount);
          }, 0);
        }
      }
      return; // Exit this function call, will retry after initialization
    } else {
      log(LogLevel.ERROR, `[${processingId}] Cannot initialize decoder: videoTrack is not available`);
      // Continue processing to log errors for each sample
    }
  }
  
      // First scan for keyframes if we haven't received one yet
      if (!keyframeReceived) {
        // Look for the first keyframe in this batch
        let keyframeIndex = -1;
        for (let i = startIndex; i < endIndex; i++) {
          if (samples[i].is_sync) {
            keyframeIndex = i;
            log(LogLevel.INFO, `[${processingId}] Found keyframe at index ${i}, sample size: ${samples[i].data.byteLength}`);
            break;
          }
        }
        
        if (keyframeIndex === -1) {
          // No keyframe found in this batch, skip all samples
          log(LogLevel.INFO, `[${processingId}] No keyframe found in batch ${startIndex}-${endIndex-1}, skipping all samples`);
          
          // If we've processed a lot of samples without finding a keyframe, force the next sample as a keyframe
          // BUT only if the decoder is in a valid state and ready to accept frames
          if (startIndex > 100 && videoDecoder && videoDecoder.state === 'configured') {
            log(LogLevel.WARNING, `[${processingId}] Processed over 100 samples without finding a keyframe.`);
            
            // Validate the sample before forcing it as a keyframe
            if (startIndex < samples.length && samples[startIndex].data && samples[startIndex].data.byteLength > 0) {
              log(LogLevel.WARNING, `[${processingId}] Forcing sample at index ${startIndex} as keyframe.`);
              keyframeReceived = true; // Force processing to continue
            } else {
              log(LogLevel.ERROR, `[${processingId}] Cannot force invalid sample as keyframe. Continuing search.`);
            }
          }
          
          // Schedule next batch if there are more samples
          if (endIndex < samples.length) {
            setTimeout(async () => {
              await processSamplesBatch(samples, endIndex, processedCount, errorCount);
            }, 0);
          }
          return;
        } else {
          // Found a keyframe, start processing from there
          log(LogLevel.INFO, `[${processingId}] Found first keyframe at index ${keyframeIndex}, starting decoding`);
          keyframeReceived = true;
          startIndex = keyframeIndex;
        }
      }
  
  for (let i = startIndex; i < endIndex; i++) {
    try {
      const sample = samples[i];
      // Log sample details for debugging
      const isKeyFrame = sample.is_sync;
      const timestamp = sample.cts * (1_000_000 / videoTrack.timescale);
      const duration = sample.duration * (1_000_000 / videoTrack.timescale);
      
      log(LogLevel.DEBUG, `[${processingId}] Processing sample - keyframe: ${isKeyFrame}, timestamp: ${timestamp}, size: ${sample.data.byteLength}`);
      
      // Create the encoded chunk
      // Force the first sample after keyframeReceived is set to be a keyframe
      // This ensures the decoder has a proper starting point
      const forceKeyFrame = (i === startIndex && keyframeReceived && !isKeyFrame);
      
      // Only force keyframe if decoder is in a valid state and the sample is valid
      if (forceKeyFrame) {
        if (videoDecoder && videoDecoder.state === 'configured' && 
            sample.data && sample.data.byteLength > 0) {
          log(LogLevel.WARNING, `[${processingId}] Forcing sample at index ${i} to be treated as keyframe`);
        } else {
          log(LogLevel.ERROR, `[${processingId}] Cannot force keyframe - decoder state: ${videoDecoder ? videoDecoder.state : 'null'}, sample valid: ${sample.data && sample.data.byteLength > 0}`);
        }
      }
      
      const chunk = new EncodedVideoChunk({
        type: (isKeyFrame || (forceKeyFrame && videoDecoder && videoDecoder.state === 'configured')) ? 'key' : 'delta',
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
          log(LogLevel.ERROR, `[${processingId}] Decoder decode error: ${e.message}`);
          
          // If we encounter too many errors, we might want to try a different approach
          if (errorCount > 5) {
            log(LogLevel.ERROR, `[${processingId}] Too many decode errors, trying to reset decoder...`);
            // Reset the decoder and keyframe tracking with exponential backoff
            keyframeReceived = false;
            
            // Implement exponential backoff for reset attempts
            const backoffDelay = Math.min(1000 * Math.pow(2, decoderResetAttempts), 10000); // Max 10 second delay
            log(LogLevel.INFO, `[${processingId}] Reset attempt ${decoderResetAttempts + 1} with ${backoffDelay}ms delay`);
            
            setTimeout(async () => {
              await resetDecoder(videoTrack);
              decoderResetAttempts++;
            }, backoffDelay);
            
            // Skip the rest of this batch after a reset
            if (endIndex < samples.length) {
              setTimeout(async () => {
                await processSamplesBatch(samples, endIndex, processedCount, errorCount);
              }, backoffDelay + 100); // Give a little extra time after the reset
            }
            return;
          }
        }
      } else {
        log(LogLevel.WARNING, `[${processingId}] Decoder not ready (state: ${videoDecoder ? videoDecoder.state : 'null'}), sample dropped`);
        errorCount++;
      }
    } catch (e) {
      errorCount++;
      log(LogLevel.ERROR, `[${processingId}] Error processing sample: ${e.message}`);
    }
  }
  
  log(LogLevel.DEBUG, `[${processingId}] Processed ${processedCount}/${samples.length} samples, ${errorCount} errors`);
  
  // If there are more samples to process, schedule the next batch
  if (endIndex < samples.length) {
    setTimeout(async () => {
      await processSamplesBatch(samples, endIndex, processedCount, errorCount);
    }, 0); // Yield to the event loop
  }
}

/**
 * Initialize the video decoder with the appropriate configuration
 * @param {TrackInfo} trackInfo - Information about the video track
 */
  async function initializeDecoder(trackInfo) {
    log(LogLevel.INFO, `[${processingId}] Initializing decoder for codec: ${trackInfo.codec}`);

    // Log detailed codec information
    log(LogLevel.DEBUG, `[${processingId}] Codec details - codec: ${trackInfo.codec}, width: ${trackInfo.codedWidth}, height: ${trackInfo.codedHeight}`);
    if (trackInfo.description) {
      log(LogLevel.DEBUG, `[${processingId}] Description buffer length: ${trackInfo.description.byteLength}`);
    } else {
      log(LogLevel.DEBUG, `[${processingId}] No codec description available`);
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
          log(LogLevel.WARNING, `[${processingId}] Error closing existing decoder: ${e.message}`);
        }
      }
      
      // For AVC/H.264 or HEVC/H.265, preserve the full codec string and description
      let configToUse = {
        codec: trackInfo.codec,
        codedWidth: trackInfo.codedWidth,
        codedHeight: trackInfo.codedHeight
      };
      
      // Add description if available
      if (trackInfo.description) {
        configToUse.description = trackInfo.description;
      }
      
      // Check for hardware acceleration support
      let hardwareAcceleration = false;
      try {
        // First check if the browser supports getSupportedConfigs (newer API)
        if (typeof VideoDecoder.getSupportedConfigs === 'function') {
          const supportedConfigs = await VideoDecoder.getSupportedConfigs();
          log(LogLevel.INFO, `[${processingId}] Supported video decoder configurations: ${JSON.stringify(supportedConfigs)}`);
          
          // Check if our codec is in the supported list
          const matchingConfig = supportedConfigs.find(config => 
            trackInfo.codec.startsWith(config.codec) && 
            config.hardwareAcceleration === 'preferred'
          );
          
          if (matchingConfig) {
            log(LogLevel.INFO, `[${processingId}] Hardware acceleration available for ${trackInfo.codec}`);
            hardwareAcceleration = true;
          }
        }
      } catch (e) {
        log(LogLevel.WARNING, `[${processingId}] Error checking hardware acceleration: ${e.message}`);
      }
      
      // Try different codec configurations
      let isSupported = false;
      
      // First try with the full config including description
      try {
        const support = await VideoDecoder.isConfigSupported(configToUse);
        log(LogLevel.INFO, `[${processingId}] Codec support for ${trackInfo.codec} with description: ${support.supported}`);
        isSupported = support.supported;
      } catch (e) {
        log(LogLevel.WARNING, `[${processingId}] Error checking codec support with description: ${e.message}`);
        isSupported = false;
      }
      
      // If not supported with description, try without it
      if (!isSupported && trackInfo.description) {
        const basicConfig = {
          codec: trackInfo.codec,
          codedWidth: trackInfo.codedWidth,
          codedHeight: trackInfo.codedHeight
        };
        
        try {
          const basicSupport = await VideoDecoder.isConfigSupported(basicConfig);
          log(LogLevel.INFO, `[${processingId}] Basic codec support (without description): ${basicSupport.supported}`);
          
          if (basicSupport.supported) {
            configToUse = basicConfig;
            isSupported = true;
          }
        } catch (e) {
          log(LogLevel.WARNING, `[${processingId}] Error checking basic codec support: ${e.message}`);
        }
      }
      
      // If still not supported, try with a more generic codec string
      if (!isSupported) {
        // Extract the basic codec type (avc1, hev1, etc.)
        const basicCodecType = trackInfo.codec.split('.')[0];
        const genericConfig = {
          codec: basicCodecType,
          codedWidth: trackInfo.codedWidth,
          codedHeight: trackInfo.codedHeight
        };
        
        try {
          const genericSupport = await VideoDecoder.isConfigSupported(genericConfig);
          log(LogLevel.INFO, `[${processingId}] Generic codec support (${basicCodecType}): ${genericSupport.supported}`);
          
          if (genericSupport.supported) {
            configToUse = genericConfig;
            isSupported = true;
          }
        } catch (e) {
          log(LogLevel.WARNING, `[${processingId}] Error checking generic codec support: ${e.message}`);
        }
      }
      
      if (!isSupported) {
        log(LogLevel.ERROR, `[${processingId}] No supported decoder configuration found for this video`);
        return;
      }
      
      log(LogLevel.INFO, `[${processingId}] Using decoder config: ${JSON.stringify(configToUse)}, hardware acceleration: ${hardwareAcceleration}`);
      
      videoDecoder = new VideoDecoder({
        output: handleFrame,
        error: handleError,
      });

      await videoDecoder.configure(configToUse);
      log(LogLevel.INFO, `[${processingId}] Decoder configured successfully`);

    } catch (err) {
      log(LogLevel.ERROR, `[${processingId}] Decoder initialization failed: ${err.message}`);
      videoDecoder = null; // Reset decoder on failure
    }
  }

/**
 * Reset the decoder by closing and reinitializing it
 * @param {Object} track - The video track information
 */
async function resetDecoder(track) {
  if (!track) {
    log(LogLevel.ERROR, `[${processingId}] Cannot reset decoder: track information not available`);
    return;
  }
  
  // Validate track information
  if (!track.codec || !track.track_width || !track.track_height) {
    log(LogLevel.ERROR, `[${processingId}] Cannot reset decoder: invalid track information`);
    log(LogLevel.DEBUG, `[${processingId}] Track details - codec: ${track.codec}, width: ${track.track_width}, height: ${track.track_height}`);
    return;
  }
  
  log(LogLevel.INFO, `[${processingId}] Resetting decoder...`);
  
  try {
    // Close the existing decoder if it exists
    if (videoDecoder) {
      try {
        if (videoDecoder.state !== 'closed') {
          videoDecoder.close();
        }
      } catch (e) {
        log(LogLevel.WARNING, `[${processingId}] Error closing decoder during reset: ${e.message}`);
      }
      videoDecoder = null;
    }
    
    // Reset keyframe tracking
    keyframeReceived = false;
    
    // Reinitialize with the same track info
    const trackInfo = {
      codec: track.codec,
      codedWidth: track.track_width,
      codedHeight: track.track_height,
      description: extractCodecDescription(track)
    };
    
    // Check if codec is supported before attempting to initialize
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec: trackInfo.codec,
        codedWidth: trackInfo.codedWidth,
        codedHeight: trackInfo.codedHeight
      });
      
      if (!support.supported) {
        log(LogLevel.ERROR, `[${processingId}] Codec ${trackInfo.codec} is not supported by this browser`);
        return;
      }
    } catch (e) {
      log(LogLevel.ERROR, `[${processingId}] Error checking codec support: ${e.message}`);
      return;
    }
    
    await initializeDecoder(trackInfo);
    log(LogLevel.INFO, `[${processingId}] Decoder reset complete`);
    
  } catch (err) {
    log(LogLevel.ERROR, `[${processingId}] Decoder reset failed: ${err.message}`);
  }
}

/**
 * Handle a decoded video frame
 * @param {VideoFrame} frame - The decoded video frame
 */
function handleFrame(frame) {
  // Log frame details for debugging
  log(LogLevel.DEBUG, `[${processingId}] Decoded frame received, timestamp: ${frame.timestamp}, size: ${frame.codedWidth}x${frame.codedHeight}`);
  
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
  log(LogLevel.ERROR, `[${processingId}] Decoder error: ${error.message}`);
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
   * Extract codec description for various video codecs (H.264/AVC, H.265/HEVC)
   * @param {Object} track - The video track
   * @returns {Uint8Array|undefined} - The codec description data or undefined
   */
  function extractCodecDescription(track) {
    if (!mp4boxfile || !track) {
      log(LogLevel.WARNING, `[${processingId}] MP4Box or track not available for description extraction`);
      return undefined;
    }
    
    try {
      log(LogLevel.DEBUG, `[${processingId}] Extracting description for codec: ${track.codec}`);
      
      // Get the track box data
      const trak = mp4boxfile.getTrackById(track.id);
      if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl || !trak.mdia.minf.stbl.stsd) {
        log(LogLevel.WARNING, `[${processingId}] Could not find stsd box for track description`);
        return undefined;
      }
      
      // For AVC/H.264, we need the avcC box data
      if (track.codec.startsWith('avc1.') || track.codec.startsWith('avc3.')) {
        log(LogLevel.DEBUG, `[${processingId}] Processing AVC/H.264 codec: ${track.codec}`);
        
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          // Check for avc1, avc3, etc.
          if (entry.avcC) {
            log(LogLevel.DEBUG, `[${processingId}] Found avcC box, extracting description`);
            
            try {
              // Try to get the avcC data directly
              if (entry.avcC.data) {
                log(LogLevel.DEBUG, `[${processingId}] Using avcC.data directly`);
                return entry.avcC.data;
              }
              
              // If no direct data access, try serializing
              const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
              entry.avcC.write(stream);
              log(LogLevel.DEBUG, `[${processingId}] Serialized avcC box, buffer size: ${stream.buffer.byteLength}`);
              
              // Return the full avcC data
              return new Uint8Array(stream.buffer);
            } catch (e) {
              log(LogLevel.ERROR, `[${processingId}] Error processing avcC box: ${e.message}`);
              // Continue to try other methods even if this one fails
            }
          }
        }
        
        // Fallback: try to create a minimal valid avcC box
        log(LogLevel.WARNING, `[${processingId}] avcC box not found or invalid, creating minimal description`);
        try {
          // Create a minimal valid avcC box (version=1, profile=baseline, compatibility=0, level=1)
          const minimalAvcC = new Uint8Array([1, 66, 0, 16, 255, 225, 0, 0]);
          return minimalAvcC;
        } catch (e) {
          log(LogLevel.ERROR, `[${processingId}] Error creating minimal avcC: ${e.message}`);
        }
      }
      // For HEVC/H.265, we need the hvcC box data
      else if (track.codec.startsWith('hvc1.') || track.codec.startsWith('hev1.')) {
        log(LogLevel.DEBUG, `[${processingId}] Processing HEVC/H.265 codec: ${track.codec}`);
        
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          // Check for hvc1, hev1, etc.
          if (entry.hvcC) {
            log(LogLevel.DEBUG, `[${processingId}] Found hvcC box, extracting description`);
            
            try {
              // Try to get the hvcC data directly
              if (entry.hvcC.data) {
                log(LogLevel.DEBUG, `[${processingId}] Using hvcC.data directly`);
                return entry.hvcC.data;
              }
              
              // If no direct data access, try serializing
              const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
              entry.hvcC.write(stream);
              log(LogLevel.DEBUG, `[${processingId}] Serialized hvcC box, buffer size: ${stream.buffer.byteLength}`);
              
              // Return the full hvcC data
              return new Uint8Array(stream.buffer);
            } catch (e) {
              log(LogLevel.ERROR, `[${processingId}] Error processing hvcC box: ${e.message}`);
            }
          }
        }
        
        log(LogLevel.WARNING, `[${processingId}] hvcC box not found for HEVC track description`);
      }
      // Add support for other codecs as needed
      else {
        log(LogLevel.INFO, `[${processingId}] No specific description extraction for codec: ${track.codec}`);
      }
      
      return undefined;
      
    } catch (error) {
      log(LogLevel.ERROR, `[${processingId}] Error extracting codec description: ${error.message}`);
      return undefined;
    }
  }

/**
 * Handle decoder flushing/closing when demuxing is complete or on error/reset
 */
async function closeDecoder() {
   if (videoDecoder && videoDecoder.state !== 'closed') {
       try {
           log(LogLevel.INFO, `[${processingId}] Flushing decoder...`);
           await videoDecoder.flush();
           videoDecoder.close();
           log(LogLevel.INFO, `[${processingId}] Decoder flushed and closed.`);
       } catch (e) {
           log(LogLevel.ERROR, `[${processingId}] Error flushing/closing decoder: ${e.message}`);
       }
   }
   
   // Clean up resources
   if (abortController) {
     abortController.abort();
     abortController = null;
   }
   
   // Clear all intervals
   checkIntervals.forEach(intervalId => clearInterval(intervalId));
   checkIntervals = [];
   
   // Reset state
   keyframeReceived = false;
   decoderResetAttempts = 0;
   
   // Signal completion
   self.postMessage({ type: 'decodeComplete' });
   videoDecoder = null; // Ensure decoder is nullified
}
