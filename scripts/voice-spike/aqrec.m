// Records the default input device to raw PCM. This exists because
// `ffmpeg -f avfoundation` blocks inside -[AVCaptureSession startRunning] when
// the agent runs in a launchd Background session; AudioQueue delivers buffers
// from the same process, so the capture layer is 60 lines here instead.
//
// The device is whatever the HAL reports as default. Selecting a microphone is
// configuration, not a mechanism, and does not belong in this file.
//
// usage: aqrec SECONDS OUT.pcm     (16 kHz, mono, signed 16-bit LE)
// exit:  0 buffers arrived, 4 silence-shaped (no buffers)
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

static FILE *gOut;
static volatile long gBytes;
static long gNeed;
static double gT0;
static int gFirstBuffer;

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
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
  if (gBytes < gNeed) AudioQueueEnqueueBuffer(q, buf, 0, NULL);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    gT0 = now_s();
    if (argc != 3) {
      fprintf(stderr, "usage: aqrec SECONDS OUT.pcm\n");
      return 2;
    }
    double seconds = atof(argv[1]);
    if (seconds <= 0 || seconds > 120) {
      fprintf(stderr, "aqrec: seconds out of range\n");
      return 2;
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
    for (int i = 0; i < (int)(seconds * 20) + 100 && gBytes < gNeed; i++) usleep(50000);
    AudioQueueStop(queue, true);
    fclose(gOut);
    AudioQueueDispose(queue, true);

    fprintf(stderr, "aqrec: bytes=%ld\n", gBytes);
    return gBytes > 0 ? 0 : 4;
  }
}
