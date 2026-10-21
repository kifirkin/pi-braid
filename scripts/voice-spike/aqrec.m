// Records the default input device to raw PCM. This exists because
// `ffmpeg -f avfoundation` blocks inside -[AVCaptureSession startRunning] when
// the agent runs in a launchd Background session; AudioQueue delivers buffers
// from the same process, so the capture layer is 60 lines here instead.
//
// The device is whatever the HAL reports as default. Selecting a microphone is
// configuration, not a mechanism, and does not belong in this file.
//
// usage: aqrec SECONDS OUT.pcm [END_MS | adaptive:HANGOVER_MS | vad:MODEL:HANGOVER_MS]
//        (16 kHz, mono, signed 16-bit LE)
// exit:  0 buffers arrived, 4 silence-shaped (no buffers)
//
// Three stopping rules, all leaving the fixed window as the fallback:
//
//   vad:MODEL:HANGOVER_MS
//                       silero v5.1.2 in ggml form, through whisper.cpp's VAD
//                       API. The model's own probability decides: a 512-sample
//                       frame at or above 0.5 is speech, and the capture stops
//                       after HANGOVER_MS of frames below it. The model is data
//                       beside the recorder, not a re-derived energy threshold.
//
//   END_MS (a number)   peak-relative: the gate sits 25 dB below the loudest
//                       frame heard so far, a stop needs 400 ms of frames
//                       above it first. On this microphone that gate sits below
//                       the room floor and never fires; kept for comparability.
//   adaptive:HANGOVER   floor-relative: the room floor is measured from the
//                       first 160 ms of every session and then tracked as a
//                       leaky minimum, the stop gate is floor+8 dB, and it may
//                       only fire after 300 ms of frames above floor+12 dB, so
//                       a transient cannot clip a phrase. The hangover is
//                       HANGOVER_MS of consecutive frames below the stop gate.
//
// The condition that fired is reported (stop_s, floor_db, gate_db, end_reason)
// so a turn can show what it did rather than be trusted to have endpointed
// correctly.
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#include "whisper.h"
#include <math.h>
#include <stdio.h>
#include <sys/time.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static FILE *gOut;
static volatile long gBytes;
static long gNeed;
static double gT0;
static int gFirstBuffer;

static volatile int gStop;          // callback asks main to stop
static int gQuietMs;                // trailing silence accumulated
static int gQuietFrames;
static int gSpeechFrames;
static int gEndMs;                  // 0 disables endpointing
static int gMode;                   // 0 window, 1 peak-relative, 2 adaptive floor
static double gFloorDb = -60.0;     // room floor, adaptive mode
// How far under the speech level counts as silence. The room is only 10-20 dB
// below speech on this microphone, so the drop has to sit inside that margin:
// 12 dB was under the room and could never fire, 6 dB sits between the two.
static double gDropDb = 6.0;
static double gLoudDb = -100.0;     // decayed maximum: what "speech level" means now
static double gBaseDb = -50.0;      // pre-playback room estimate, for arming only
static double gGateDb = -90.0;      // peak-relative, so it only ever fails safe
static double gNoiseDb = 0.0;
static double gPeakDb = -120.0;
static int gArmed;                  // enough speech seen to allow a stop
static int gCalibN;
static int gCalibDone;

// A stop needs 400 ms of frames above the gate first. A click or a door can be
// loud for 20 ms; only sustained speech arms the hangover, so a spurious
// transient costs a stop rather than a clipped phrase.
#define ARM_FRAMES 20
#define GATE_BELOW_PEAK_DB 25.0
static double gCalib[8];            // first 160 ms, pre-playback room tone

// silero v5.1.2, ggml, through whisper.cpp's VAD API. The model sees one
// 512-sample window (32 ms at 16 kHz) per call and keeps its LSTM state across
// calls, which is the streaming contract; feeding it 320-sample AudioQueue
// buffers directly would zero-pad every window and corrupt that state.
#define VAD_FRAME 512
#define VAD_RATE 16000
#define VAD_P_THRESHOLD 0.5f

static struct whisper_vad_context *gVad;
static int gVadRequested;
static int gVadFailed;
static int gVadHangoverMs;
static char gVadModel[1024];
static double gVadInitMs;
static float gVadFrame[VAD_FRAME];
static int gVadFill;
static long gVadSamples;
static long gVadFrames;
static long gVadSpeechFrames;
static int gVadProbsPerCall;
static double gVadLastSpeechEndS = -1.0;
static double gVadLastP;
static double gVadMaxP;
static double gVadStopAudioS;
static double gStopWallS;

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static double frame_db(const short *s, int n) {
  double energy = 0.0;
  for (int i = 0; i < n; i++) energy += (double)s[i] * (double)s[i];
  double rms = sqrt(energy / (n ? n : 1)) / 32768.0;
  return rms > 0.0 ? 20.0 * log10(rms) : -120.0;
}

// whisper.cpp logs a line per VAD call at info level; one call per 32 ms would
// bury the recorder's own record, so the library's logger is silenced here.
static void quiet_log(enum ggml_log_level level, const char *text, void *user) {
  (void)level; (void)text; (void)user;
}

static void vad_frame(void) {
  // The frame covers [gVadSamples, gVadSamples + VAD_FRAME), so frame_end is
  // the audio-clock instant at which a decision applies. The hangover starts
  // at the end of the last frame the model called speech, so it cannot be
  // shortened by a level change in the room.
  double frame_end = (double)(gVadSamples + VAD_FRAME) / VAD_RATE;
  if (!whisper_vad_detect_speech_no_reset(gVad, gVadFrame, VAD_FRAME)) {
    gVadFailed = 1;
    gVadSamples += VAD_FRAME;
    return;
  }
  int n = whisper_vad_n_probs(gVad);
  float *probs = whisper_vad_probs(gVad);
  float p = n > 0 ? probs[n - 1] : 0.0f;
  gVadSamples += VAD_FRAME;
  gVadFrames++;
  gVadProbsPerCall = n;
  gVadLastP = p;
  if (p > gVadMaxP) gVadMaxP = p;
  if (p >= VAD_P_THRESHOLD) {
    gVadSpeechFrames++;
    gVadLastSpeechEndS = frame_end;
  } else if (gVadLastSpeechEndS >= 0.0) {
    if ((frame_end - gVadLastSpeechEndS) * 1000.0 >= gVadHangoverMs) {
      gVadStopAudioS = frame_end;
      gStopWallS = now_s() - gT0;
      gStop = 1;
    }
  }
}

static void vad_feed(const short *s, int n) {
  for (int i = 0; i < n && !gStop; i++) {
    gVadFrame[gVadFill++] = (float)s[i] / 32768.0f;
    if (gVadFill == VAD_FRAME) {
      vad_frame();
      gVadFill = 0;
    }
  }
}

static void on_buffer(void *ud, AudioQueueRef q, AudioQueueBufferRef buf,
                      const AudioTimeStamp *ts, UInt32 packets,
                      const AudioStreamPacketDescription *desc) {
  if (!gOut) return;
  if (!gFirstBuffer) {
    gFirstBuffer = 1;
    fprintf(stderr, "first_buffer_s=%.6f\n", now_s() - gT0);
  }
  fwrite(buf->mAudioData, 1, buf->mAudioDataByteSize, gOut);
  gBytes += buf->mAudioDataByteSize;

  // Buffers are 640 bytes = 20 ms at 16 kHz, two thirds of one VAD frame.
  int samples = (int)(buf->mAudioDataByteSize / 2);
  if (gVad && !gStop) vad_feed((const short *)buf->mAudioData, samples);

  if (gEndMs > 0 && !gStop) {
    double db = frame_db((const short *)buf->mAudioData, samples);
    if (!gCalibDone) {
      if (gCalibN < 8) gCalib[gCalibN] = db;
      if (++gCalibN >= 8) {
        qsort(gCalib, 8, sizeof(double), cmp_double);
        gNoiseDb = 0.5 * (gCalib[3] + gCalib[4]);
        // 25th percentile, not the median: with only eight frames of room
        // tone before playback, one frame of the stimulus would move the
        // median into the speech band.
        gFloorDb = gCalib[1];
        gCalibDone = 1;
      }
    } else if (gMode == 2) {
      // Level-relative, not floor-relative. Two absolute gates were tried on
      // this microphone and both failed: one 25 dB under the loudest frame sat
      // below the room floor, and one tied to a measured floor sat inside the
      // room's own variance, so the stop was a coin flip on noise and never
      // fired. What separates speech from this room is not where the floor is
      // but how far the level falls from the speech it followed, so the gate is
      // a decayed maximum minus a fixed drop. The decay (7.5 dB/s) means a gate
      // that was set during a loud sentence comes down to the room within half
      // a second, and the hangover is measured from the last loud frame.
      if (gLoudDb < db) gLoudDb = db;
      else gLoudDb -= 0.15;
      if (gLoudDb < -100.0) gLoudDb = -100.0;
      if (!gArmed) {
        // Arming uses the pre-playback room estimate, which is a low estimate:
        // arming too easily only costs a stop that the hangover must then
        // confirm, while arming too late leaves the fixed window in place.
        if (db > gBaseDb + 10.0) gSpeechFrames++;
        else if (gSpeechFrames > 0) gSpeechFrames--;
        if (gSpeechFrames >= 15) gArmed = 1;    // 300 ms of speech, decayed
      } else {
        int quiet = (db < gLoudDb - gDropDb) && (gLoudDb > gBaseDb + 8.0);
        if (!quiet) {
          gQuietFrames = 0;
          gQuietMs = 0;
        } else {
          gQuietFrames++;
          gQuietMs += 20;
          if (gQuietMs >= gEndMs) {
            gStop = 1;
            fprintf(stderr, "floor_db=%.1f\n", gBaseDb);
            fprintf(stderr, "loud_db=%.1f\n", gLoudDb);
            fprintf(stderr, "gate_db=%.1f\n", gLoudDb - gDropDb);
            fprintf(stderr, "speech_frames=%d\n", gSpeechFrames);
            fprintf(stderr, "quiet_frames=%d\n", gQuietFrames);
            fprintf(stderr, "stop_s=%.6f\n", now_s() - gT0);
            fprintf(stderr, "end_reason=endpoint\n");
          }
        }
      }
    } else {
      if (db > gPeakDb) gPeakDb = db;
      // The gate follows the loudest frame heard so far, 25 dB down. A gate
      // derived from the room floor alone sat above quiet speech frames on
      // this path and ended captures mid-phrase; a gate this low can only fail
      // by not stopping, which leaves the fixed window as the fallback.
      gGateDb = gPeakDb - GATE_BELOW_PEAK_DB;
      if (db > gGateDb) {
        gSpeechFrames++;
        gQuietFrames = 0;
        gQuietMs = 0;
        if (gSpeechFrames >= ARM_FRAMES) gArmed = 1;
      } else if (gArmed) {
        gQuietFrames++;
        gQuietMs += 20;
        if (gQuietMs >= gEndMs) {
          gStop = 1;
          fprintf(stderr, "noise_db=%.1f\n", gNoiseDb);
          fprintf(stderr, "peak_db=%.1f\n", gPeakDb);
          fprintf(stderr, "gate_db=%.1f\n", gGateDb);
          fprintf(stderr, "speech_frames=%d\n", gSpeechFrames);
          fprintf(stderr, "quiet_frames=%d\n", gQuietFrames);
          fprintf(stderr, "stop_s=%.6f\n", now_s() - gT0);
          fprintf(stderr, "end_reason=endpoint\n");
        }
      }
    }
  }

  if (gBytes < gNeed) AudioQueueEnqueueBuffer(q, buf, 0, NULL);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    gT0 = now_s();
    // The caller anchors this recorder's audio clock at the moment it spawned
    // the process. If the child is scheduled late, that anchor is wrong by the
    // delay; the wall-clock stamp lets the caller measure and remove it.
    struct timeval tv_start;
    gettimeofday(&tv_start, NULL);
    fprintf(stderr, "t0_unix=%.6f\n", tv_start.tv_sec + tv_start.tv_usec / 1e6);
    if (argc < 3 || argc > 4) {
      fprintf(stderr, "usage: aqrec SECONDS OUT.pcm [END_MS | adaptive:HANGOVER_MS | vad:MODEL:HANGOVER_MS]\n");
      return 2;
    }
    double seconds = atof(argv[1]);
    if (seconds <= 0 || seconds > 120) {
      fprintf(stderr, "aqrec: seconds out of range\n");
      return 2;
    }
    if (argc == 4) {
      if (strncmp(argv[3], "vad:", 4) == 0) {
        // vad:MODEL:HANGOVER_MS, split on the last colon so a path may hold
        // one; the model path is data and is printed in every turn's record.
        char *spec = strdup(argv[3] + 4);
        char *sep = spec ? strrchr(spec, ':') : NULL;
        if (!sep) {
          free(spec);
          fprintf(stderr, "aqrec: vad needs MODEL:HANGOVER_MS\n");
          return 2;
        }
        *sep = '\0';
        if (strlen(spec) >= sizeof(gVadModel)) {
          free(spec);
          fprintf(stderr, "aqrec: vad model path too long\n");
          return 2;
        }
        snprintf(gVadModel, sizeof(gVadModel), "%s", spec);
        gVadHangoverMs = atoi(sep + 1);
        free(spec);
        gVadRequested = 1;
      } else if (strncmp(argv[3], "adaptive:", 9) == 0) {
        gMode = 2;
        gEndMs = atoi(argv[3] + 9);
      } else {
        gMode = 1;
        gEndMs = atoi(argv[3]);
      }
    }
    if (gVadRequested && (gVadHangoverMs < 100 || gVadHangoverMs > 3000)) {
      fprintf(stderr, "aqrec: vad hangover out of range\n");
      return 2;
    }
    if (gMode == 2 && (gEndMs < 100 || gEndMs > 3000)) {
      fprintf(stderr, "aqrec: adaptive hangover out of range\n");
      return 2;
    }
    if (gMode == 1 && (gEndMs < 0 || gEndMs > (int)(seconds * 1000))) {
      fprintf(stderr, "aqrec: END_MS out of range\n");
      return 2;
    }
    if (gVadRequested) {
      // Loading the model is session setup, not per-turn work; the time is
      // printed so a cold run is visible in the record rather than inferred.
      double t_vad = now_s();
      whisper_log_set(quiet_log, NULL);
      struct whisper_vad_context_params cp = whisper_vad_default_context_params();
      cp.n_threads = 1;
      cp.use_gpu = false;
      gVad = whisper_vad_init_from_file_with_params(gVadModel, cp);
      gVadInitMs = (now_s() - t_vad) * 1000.0;
      fprintf(stderr, "vad_model=%s\n", gVadModel);
      fprintf(stderr, "vad_threshold=%.3f\n", (double)VAD_P_THRESHOLD);
      fprintf(stderr, "vad_hangover_ms=%d\n", gVadHangoverMs);
      fprintf(stderr, "vad_init_ms=%.1f\n", gVadInitMs);
      if (!gVad) {
        gVadFailed = 1;
        fprintf(stderr, "vad_init=FAILED\n");
      } else {
        fprintf(stderr, "vad_init=ok\n");
      }
    }

    gNeed = (long)(seconds * 16000 * 2);
    gOut = fopen(argv[2], "wb");
    if (!gOut) { perror("aqrec: fopen"); return 2; }

    AudioStreamBasicDescription fmt = {0};
    fmt.mSampleRate = 16000;
    fmt.mFormatID = kAudioFormatLinearPCM;
    fmt.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    fmt.mBytesPerPacket = 2;
    fmt.mFramesPerPacket = 1;
    fmt.mBytesPerFrame = 2;
    fmt.mChannelsPerFrame = 1;
    fmt.mBitsPerChannel = 16;

    AudioQueueRef queue = NULL;
    OSStatus st = AudioQueueNewInput(&fmt, on_buffer, NULL, NULL, NULL, 0, &queue);
    if (st != noErr) {
      fprintf(stderr, "aqrec: AudioQueueNewInput=%d\n", (int)st);
      return 3;
    }
    for (int i = 0; i < 4; i++) {
      AudioQueueBufferRef buf;
      AudioQueueAllocateBuffer(queue, 640, &buf);
      buf->mAudioDataByteSize = 640;
      AudioQueueEnqueueBuffer(queue, buf, 0, NULL);
    }
    st = AudioQueueStart(queue, NULL);
    if (st != noErr) {
      fprintf(stderr, "aqrec: AudioQueueStart=%d\n", (int)st);
      return 3;
    }
    fprintf(stderr, "started_s=%.6f\n", now_s() - gT0);

    // 0.5 s grace on top of the requested length, then give up; a missing
    // input volume still yields buffers, just zeros, so the caller checks RMS.
    for (int i = 0; i < (int)(seconds * 20) + 100 && gBytes < gNeed && !gStop; i++)
      usleep(20000);
    AudioQueueStop(queue, true);
    fclose(gOut);
    AudioQueueDispose(queue, true);

    if (gEndMs > 0 && !gStop && !gVadRequested) {
      fprintf(stderr, "noise_db=%.1f\n", gNoiseDb);
      fprintf(stderr, "peak_db=%.1f\n", gPeakDb);
      fprintf(stderr, "floor_db=%.1f\n", gMode == 2 ? gBaseDb : gNoiseDb);
      fprintf(stderr, "gate_db=%.1f\n", gMode == 2 ? gLoudDb - gDropDb : gGateDb);
      fprintf(stderr, "loud_db=%.1f\n", gLoudDb);
      fprintf(stderr, "armed=%d\n", gArmed);
      fprintf(stderr, "speech_frames=%d\n", gSpeechFrames);
      fprintf(stderr, "quiet_frames=%d\n", gQuietFrames);
      fprintf(stderr, "stop_s=%.6f\n", now_s() - gT0);
      fprintf(stderr, "end_reason=window\n");
    }
    if (gVadRequested) {
      fprintf(stderr, "vad_frames=%ld\n", gVadFrames);
      fprintf(stderr, "vad_speech_frames=%ld\n", gVadSpeechFrames);
      fprintf(stderr, "vad_probs_per_call=%d\n", gVadProbsPerCall);
      fprintf(stderr, "vad_max_p=%.4f\n", gVadMaxP);
      fprintf(stderr, "vad_last_p=%.4f\n", gVadLastP);
      fprintf(stderr, "vad_last_speech_end_s=%.3f\n", gVadLastSpeechEndS);
      fprintf(stderr, "vad_stop_audio_s=%.3f\n", gVadStopAudioS);
      fprintf(stderr, "vad_failed=%d\n", gVadFailed);
      fprintf(stderr, "stop_s=%.6f\n", gStop ? gStopWallS : now_s() - gT0);
      fprintf(stderr, "end_reason=%s\n", gStop ? "vad" : "window");
    }
    if (gVad) whisper_vad_free(gVad);
    fprintf(stderr, "bytes_s=%.3f\n", gBytes / 32000.0);
    fprintf(stderr, "aqrec: bytes=%ld\n", gBytes);
    return gBytes > 0 ? 0 : 4;
  }
}
