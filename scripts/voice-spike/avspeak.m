// A resident speech synthesizer: text in on stdin, PCM out through an
// AudioQueue, one long-lived process.
//
// `say -o` pays a fixed cost before its first sample exists: the process starts,
// the voice loads, and only then does synthesis begin. That cost is the same for
// a short sentence and a long one, so no amount of chunking removes it. This
// process pays it once at startup (a silent warm-up utterance), then answers
// each instruction with a number measured from "text received" to "first PCM
// buffer handed to the device".
//
//   printf 'SPEAK\tthe transcript is ready.\n' | avspeak
//
// Protocol: one instruction per line on stdin, one JSON object per line on
// stdout after the utterance drains. `SPEAK\t<text>` synthesizes and plays
// (tabs and newlines cannot appear in the text). `QUIT` exits. A line that
// starts with anything else is a protocol error, not speech.
//
// The three timestamps a caller needs are reported separately because they
// fail differently: `synth_first_ms` is the synthesizer producing audio,
// `first_enqueue_ms` is that audio being handed to the device, and
// `first_consumed_ms` is when the AudioQueue reported the first buffer back.
// The consumed callback tracks buffer consumption rather than the last sample
// leaving the speaker, so it is a lower bound and not a playback time. None of
// these three proves a sample reached a speaker; only a microphone can.
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define POOL 4
#define MAX_CHANNELS 2

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void fail(const char *what, OSStatus st) {
  fprintf(stderr, "avspeak: %s failed (%d)\n", what, (int)st);
  exit(3);
}

// ---- utterance state ------------------------------------------------------

static double gT_command;      // instruction read on stdin
static double gT_synth_first;  // first buffer out of the synthesizer
static double gT_enqueue;      // first buffer handed to AudioQueue
static double gT_played;       // first buffer finished playing, corrected
static double gT_synth_done;   // synthesizer signalled end of utterance
static long gFrames_in;        // frames the synthesizer produced
static int gFirst_callback;
static int gFinish_seen;

static double gSample_rate;
static int gChannels;
static long gChunk_frames;

// ---- output queue ---------------------------------------------------------

static AudioQueueRef gQueue;
static AudioQueueBufferRef gBuffers[POOL];
static int gBusy[POOL];
static int gRunning;
static int gOut_first;

static short *gPending;        // interleaved s16, waiting for a free buffer
static size_t gPend_frames;
static size_t gPend_cap;

static pthread_mutex_t gLock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gDrained = PTHREAD_COND_INITIALIZER;

static void pending_append(const short *src, size_t frames) {
  if (gPend_frames + frames > gPend_cap) {
    size_t cap = (gPend_frames + frames) * 2 + 4800;
    gPending = realloc(gPending, cap * sizeof(short));
    if (!gPending) fail("realloc", (OSStatus)0);
    gPend_cap = cap;
  }
  memcpy(gPending + gPend_frames * gChannels, src, frames * gChannels * sizeof(short));
  gPend_frames += frames;
}

static void pending_consume(size_t frames) {
  size_t rest = gPend_frames - frames;
  if (rest) memmove(gPending, gPending + frames * gChannels, rest * gChannels * sizeof(short));
  gPend_frames = rest;
}

static void queue_start(void) {
  if (gRunning) return;
  OSStatus st = AudioQueueStart(gQueue, NULL);
  if (st != noErr) fail("AudioQueueStart", st);
  gRunning = 1;
}

static void pump(void);  // fwd

static void on_output(void *ud, AudioQueueRef q, AudioQueueBufferRef buf) {
  int idx = -1;
  for (int i = 0; i < POOL; i++)
    if (gBuffers[i] == buf) idx = i;
  double t = now_s();
  pthread_mutex_lock(&gLock);
  if (idx >= 0) gBusy[idx] = 0;
  if (!gOut_first) {
    gOut_first = 1;
    gT_played = t;
  }
  pump();
  if (gFinish_seen && gPend_frames == 0) {
    int any = 0;
    for (int i = 0; i < POOL; i++) any |= gBusy[i];
    if (!any) pthread_cond_signal(&gDrained);
  }
  pthread_mutex_unlock(&gLock);
}

// Fill every free buffer it can. A silent gap longer than one buffer would
// underrun the queue; the synthesizer runs faster than playback, so in practice
// only the first buffer ever waits, and the wait is bounded by synthesis of the
// first chunk, which is what the caller is measuring anyway.
static void pump(void) {
  for (;;) {
    int free_idx = -1;
    for (int i = 0; i < POOL; i++)
      if (!gBusy[i]) { free_idx = i; break; }
    if (free_idx < 0) return;

    size_t want = (size_t)gChunk_frames;
    size_t have = gPend_frames < want ? gPend_frames : want;
    if (have == 0 && !gFinish_seen) return;
    if (have == 0 && gFinish_seen) return;

    if (!gT_enqueue) gT_enqueue = now_s();
    size_t bytes = have * gChannels * sizeof(short);
    memcpy(gBuffers[free_idx]->mAudioData, gPending, bytes);
    gBuffers[free_idx]->mAudioDataByteSize = (UInt32)bytes;
    pending_consume(have);
    OSStatus st = AudioQueueEnqueueBuffer(gQueue, gBuffers[free_idx], 0, NULL);
    if (st != noErr) fail("AudioQueueEnqueueBuffer", st);
    gBusy[free_idx] = 1;
    queue_start();
  }
}

static void on_synth_buffer(AVAudioBuffer *buffer) {
  double t = now_s();
  if (!gFirst_callback) {
    gFirst_callback = 1;
    gT_synth_first = t;
  }
  AVAudioPCMBuffer *pcm = (AVAudioPCMBuffer *)buffer;
  if (![pcm isKindOfClass:[AVAudioPCMBuffer class]] || pcm.frameLength == 0) {
    pthread_mutex_lock(&gLock);
    gFinish_seen = 1;
    gT_synth_done = t;
    pthread_mutex_unlock(&gLock);
    return;
  }

  AVAudioFormat *fmt = pcm.format;
  if (!gQueue) {
    gSample_rate = fmt.sampleRate;
    gChannels = (int)fmt.channelCount;
    if (gChannels < 1) gChannels = 1;
    if (gChannels > MAX_CHANNELS) gChannels = MAX_CHANNELS;
    gChunk_frames = (long)(gSample_rate * 0.05);  // 50 ms

    AudioStreamBasicDescription asbd = {0};
    asbd.mSampleRate = gSample_rate;
    asbd.mFormatID = kAudioFormatLinearPCM;
    asbd.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    asbd.mChannelsPerFrame = (UInt32)gChannels;
    asbd.mBitsPerChannel = 16;
    asbd.mBytesPerFrame = (UInt32)(sizeof(short) * gChannels);
    asbd.mBytesPerPacket = asbd.mBytesPerFrame;
    asbd.mFramesPerPacket = 1;
    OSStatus st = AudioQueueNewOutput(&asbd, on_output, NULL, NULL, NULL, 0, &gQueue);
    if (st != noErr) fail("AudioQueueNewOutput", st);
    for (int i = 0; i < POOL; i++) {
      st = AudioQueueAllocateBuffer(gQueue, (UInt32)(gChunk_frames * asbd.mBytesPerFrame),
                                    &gBuffers[i]);
      if (st != noErr) fail("AudioQueueAllocateBuffer", st);
      gBusy[i] = 0;
    }
  }

  // Convert whatever the synthesizer hands over into interleaved s16: the one
  // format AudioQueue reads on every macOS this might run on.
  long frames = (long)pcm.frameLength;
  gFrames_in += frames;
  short *tmp = malloc(frames * gChannels * sizeof(short));
  if (!tmp) fail("malloc", (OSStatus)0);
  // The synthesizer's own format is whatever the installed voice uses, so this
  // reads either float or integer samples, interleaved or not. Int32 is the
  // fallback for a format this build has not seen rather than a guess.
  int32_t fmt_id = fmt.commonFormat;
  for (long f = 0; f < frames; f++) {
    for (int c = 0; c < gChannels; c++) {
      int avail = c < (int)fmt.channelCount ? c : (int)fmt.channelCount - 1;
      float v = 0.0f;
      if (fmt_id == AVAudioPCMFormatFloat32) {
        v = fmt.isInterleaved ? pcm.floatChannelData[0][f * fmt.channelCount + avail]
                              : pcm.floatChannelData[avail][f];
      } else if (fmt_id == AVAudioPCMFormatInt16) {
        v = (float)pcm.int16ChannelData[avail][f] / 32768.0f;
      } else {
        v = (float)pcm.int32ChannelData[avail][f] / 2147483648.0f;
      }
      if (v > 1.0f) v = 1.0f;
      if (v < -1.0f) v = -1.0f;
      tmp[f * gChannels + c] = (short)(v * 32767.0f);
    }
  }
  pthread_mutex_lock(&gLock);
  pending_append(tmp, (size_t)frames);
  pump();
  pthread_mutex_unlock(&gLock);
  free(tmp);
}

static void reset_utterance(void) {
  pthread_mutex_lock(&gLock);
  gPend_frames = 0;
  gFinish_seen = 0;
  gOut_first = 0;
  pthread_mutex_unlock(&gLock);
  gFirst_callback = 0;
  gT_synth_first = 0;
  gT_enqueue = 0;
  gT_played = 0;
  gT_synth_done = 0;
  gFrames_in = 0;
}

// Returns NULL when the utterance played out, or a static reason string when
// it did not. The first-buffer watchdog is separate from the drain deadline so
// a synthesizer that never calls back reports in seconds instead of minutes.
static const char *wait_drained(double limit_s, double first_limit_s) {
  double start = now_s();
  double deadline = start + limit_s;
  const char *why = NULL;
  pthread_mutex_lock(&gLock);
  while (!gFirst_callback && now_s() - start > first_limit_s) { pthread_mutex_unlock(&gLock); return "no buffer callback"; }
  while (1) {
    int any = 0;
    for (int i = 0; i < POOL; i++) any |= gBusy[i];
    if (gFinish_seen && gPend_frames == 0 && !any) break;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_nsec += 20000000;
    if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
    pthread_cond_timedwait(&gDrained, &gLock, &ts);
    if (!gFirst_callback && now_s() - start > first_limit_s) { why = "no buffer callback"; break; }
    if (now_s() > deadline) { why = "drain timeout"; break; }
  }
  // Every buffer that came back is heard; anything still outstanding is a
  // queue that underran and will never return, so it is flushed and the pool
  // cleared. A stale callback after this point would mark a buffer busy for
  // the next utterance, which is the one state error that survives utterances.
  if (gQueue) {
    AudioQueueStop(gQueue, true);
    AudioQueueReset(gQueue);
    for (int i = 0; i < POOL; i++) gBusy[i] = 0;
    gRunning = 0;
  }
  pthread_mutex_unlock(&gLock);
  return why;
}

static AVSpeechSynthesizer *gSynth;
static AVSpeechUtterance *gUtter;
static int gWarmDone;
static char gVoiceId[256];
static char gVoiceName[256];
static char gSeen[4096];
static double gWarm_ms;
static int gInit_ok;

static void submit(AVSpeechUtterance *u) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [gSynth writeUtterance:u toBufferCallback:^(AVAudioBuffer *b) { on_synth_buffer(b); }];
  });
  if (gWarmDone && gQueue) AudioQueueSetParameter(gQueue, kAudioQueueParam_Volume, 1.0f);
}

// Main queue: the synthesizer delivers its buffers here, so this is the thread
// that must stay free. Nothing in the reader below blocks it.
static void warm_up(void) {  // runs on the reader thread
  AVSpeechUtterance *warm = [AVSpeechUtterance speechUtteranceWithString:@"The transcript is ready."];
  warm.voice = [AVSpeechSynthesisVoice voiceWithIdentifier:[NSString stringWithUTF8String:gVoiceId]];
  reset_utterance();
  double t0 = now_s();
  // Submitted to the main queue and awaited from this thread: the synthesizer
  // delivers its buffers on the main queue, so a caller that both posts the
  // write and blocks waiting for it on that same queue waits forever.
  submit(warm);
  const char *why = wait_drained(10.0, 10.0);
  gWarm_ms = (now_s() - t0) * 1000.0;
  // An utterance at volume 0 makes the synthesizer skip the audio path
  // entirely, so the warm-up speaks at full level into a muted queue.
  if (gQueue) AudioQueueSetParameter(gQueue, kAudioQueueParam_Volume, 1.0f);
  gInit_ok = (why == NULL && gSample_rate > 0);
  if (why) fprintf(stderr, "warm_failed=%s\n", why);
  gWarmDone = 1;
}

static void speak_one(const char *text) {
  reset_utterance();
  gT_command = now_s();
  NSString *s = [NSString stringWithUTF8String:text];
  gUtter = [AVSpeechUtterance speechUtteranceWithString:s];
  gUtter.voice = [AVSpeechSynthesisVoice voiceWithIdentifier:[NSString stringWithUTF8String:gVoiceId]];
  submit(gUtter);
  const char *why = wait_drained(60.0, 8.0);
  double audio_s = gSample_rate > 0 ? (double)gFrames_in / gSample_rate : 0.0;
  char errtok[80];
  if (why) snprintf(errtok, sizeof errtok, "\"%s\"", why);
  else snprintf(errtok, sizeof errtok, "null");
  printf("{\"ok\":%s,\"chars\":%lu,"
         "\"synth_first_ms\":%.1f,\"first_enqueue_ms\":%.1f,"
         "\"first_consumed_ms\":%.1f,\"synth_done_ms\":%.1f,"
         "\"audio_ms\":%.1f,\"frames\":%ld,\"sample_rate\":%d,"
         "\"channels\":%d,\"voice\":\"%s\",\"error\":%s}\n",
         why ? "false" : "true", (unsigned long)[s length],
         gT_synth_first ? (gT_synth_first - gT_command) * 1000.0 : -1.0,
         gT_enqueue ? (gT_enqueue - gT_command) * 1000.0 : -1.0,
         gT_played ? (gT_played - gT_command) * 1000.0 : -1.0,
         gT_synth_done ? (gT_synth_done - gT_command) * 1000.0 : -1.0,
         audio_s * 1000.0, gFrames_in, (int)gSample_rate, gChannels,
         gVoiceId, errtok);
  fflush(stdout);
}

static void *reader(void *ud) {
  (void)ud;
  warm_up();
  fprintf(stderr, "warm_ms=%.1f\n", gWarm_ms);
  fprintf(stderr, "voice=%s\n", gVoiceId);
  fprintf(stderr, "voice_name=%s\n", gVoiceName);
  fprintf(stderr, "sample_rate=%d\n", (int)gSample_rate);
  fprintf(stderr, "channels=%d\n", gChannels);
  fprintf(stderr, "chunk_ms=%.0f\n", gSample_rate > 0 ? 1000.0 * (double)gChunk_frames / gSample_rate : 0.0);
  fprintf(stderr, "en_us_voices=%s\n", gSeen);

  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&line, &cap, stdin)) > 0) {
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    if (n == 0) continue;
    if (strcmp(line, "QUIT") == 0) break;
    if (strncmp(line, "SPEAK\t", 6) != 0) {
      fprintf(stderr, "avspeak: bad instruction: %s\n", line);
      printf("{\"ok\":false,\"error\":\"bad instruction\"}\n");
      fflush(stdout);
      continue;
    }
    speak_one(line + 6);
  }
  free(line);
  dispatch_async(dispatch_get_main_queue(), ^{ exit(0); });
  return NULL;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    NSString *want = nil;
    if (argc > 1) want = [NSString stringWithUTF8String:argv[1]];

    AVSpeechSynthesisVoice *voice = nil;
    NSMutableArray *seen = [NSMutableArray array];
    for (AVSpeechSynthesisVoice *v in [AVSpeechSynthesisVoice speechVoices]) {
      if (![v.language isEqualToString:@"en-US"]) continue;
      [seen addObject:[NSString stringWithFormat:@"%@|%@", v.name, v.identifier]];
      if (want && [v.name isEqualToString:want]) voice = v;
    }
    if (!voice) voice = [AVSpeechSynthesisVoice voiceWithLanguage:@"en-US"];
    if (!voice) {
      fprintf(stderr, "avspeak: no en-US voice installed\n");
      return 2;
    }
    snprintf(gVoiceId, sizeof gVoiceId, "%s", [voice.identifier UTF8String]);
    snprintf(gVoiceName, sizeof gVoiceName, "%s", [voice.name UTF8String]);
    snprintf(gSeen, sizeof gSeen, "%s", [[seen componentsJoinedByString:@";"] UTF8String]);

    gSynth = [[AVSpeechSynthesizer alloc] init];
    // The voice and the audio path are paid for once, on the reader thread
    // before any instruction is accepted, in a muted utterance whose output is
    // discarded. No measured utterance pays them.
    pthread_t th;
    if (pthread_create(&th, NULL, reader, NULL) != 0) {
      fprintf(stderr, "avspeak: pthread_create failed\n");
      return 3;
    }
    dispatch_main();
  }
  return 0;
}
