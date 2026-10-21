// Reads and sets the system default input and output device.
//
// A measurement is only comparable to another measurement on the same device
// pair, and macOS silently changes both defaults when a Bluetooth speaker
// connects: the microphone then becomes the speaker's narrowband headset mic,
// which records a quarter of the signal it recorded from the built-in one. This
// tool exists so a batch can pin the pair, print what it found, and put it back.
//
// usage:
//   audio-device list
//   audio-device get in|out
//   audio-device set in|out NAME_OR_UID
//
// `get` prints `name=`, `uid=`, `transport=` and `sample_rate=` lines. `set`
// accepts a device name (exact, then case-insensitive) or a UID. Exit 1 when a
// device cannot be resolved.
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <string.h>

static NSString *string_prop(AudioObjectID obj, AudioObjectPropertySelector sel,
                             AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress addr = {sel, scope, kAudioObjectPropertyElementMain};
  CFStringRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(obj, &addr, 0, NULL, &size, &value) != noErr || !value)
    return nil;
  return (__bridge_transfer NSString *)value;
}

static BOOL has_streams(AudioObjectID dev, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyStreamConfiguration, scope,
                                    kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(dev, &addr, 0, NULL, &size) != noErr || size == 0)
    return NO;
  AudioBufferList *list = (AudioBufferList *)malloc(size);
  if (!list) return NO;
  BOOL any = NO;
  if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, list) == noErr)
    for (UInt32 i = 0; i < list->mNumberBuffers; i++)
      if (list->mBuffers[i].mNumberChannels > 0) any = YES;
  free(list);
  return any;
}

static NSArray<NSNumber *> *all_devices(void) {
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDevices,
                                    kAudioObjectPropertyScopeGlobal,
                                    kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size) != noErr)
    return @[];
  UInt32 count = size / sizeof(AudioDeviceID);
  AudioDeviceID *ids = (AudioDeviceID *)malloc(size);
  if (!ids) return @[];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, ids) != noErr) {
    free(ids);
    return @[];
  }
  NSMutableArray<NSNumber *> *out = [NSMutableArray arrayWithCapacity:count];
  for (UInt32 i = 0; i < count; i++) [out addObject:@(ids[i])];
  free(ids);
  return out;
}

static AudioDeviceID default_device(BOOL input) {
  AudioObjectPropertyAddress addr = {
      input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioDeviceID dev = kAudioObjectUnknown;
  UInt32 size = sizeof(dev);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &dev) != noErr)
    return kAudioObjectUnknown;
  return dev;
}

static const char *transport_name(UInt32 t) {
  switch (t) {
    case kAudioDeviceTransportTypeBuiltIn: return "built-in";
    case kAudioDeviceTransportTypeBluetooth: return "bluetooth";
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth-le";
    case kAudioDeviceTransportTypeUSB: return "usb";
    case kAudioDeviceTransportTypeAggregate: return "aggregate";
    case kAudioDeviceTransportTypeVirtual: return "virtual";
    case kAudioDeviceTransportTypeAirPlay: return "airplay";
    case kAudioDeviceTransportTypeHDMI: return "hdmi";
    case kAudioDeviceTransportTypeDisplayPort: return "displayport";
    case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt";
    case kAudioDeviceTransportTypePCI: return "pci";
    case kAudioDeviceTransportTypeFireWire: return "firewire";
    case kAudioDeviceTransportTypeContinuityCaptureWired: return "continuity-wired";
    case kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity-wireless";
    default: return "unknown";
  }
}

static void print_device(AudioDeviceID dev) {
  NSString *name = string_prop(dev, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
  NSString *uid = string_prop(dev, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal);
  AudioObjectPropertyAddress rate_addr = {kAudioDevicePropertyNominalSampleRate,
                                         kAudioObjectPropertyScopeGlobal,
                                         kAudioObjectPropertyElementMain};
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  if (AudioObjectGetPropertyData(dev, &rate_addr, 0, NULL, &size, &rate) != noErr) rate = 0;
  AudioObjectPropertyAddress transport_addr = {kAudioDevicePropertyTransportType,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
  UInt32 transport = kAudioDeviceTransportTypeUnknown;
  size = sizeof(transport);
  if (AudioObjectGetPropertyData(dev, &transport_addr, 0, NULL, &size, &transport) != noErr)
    transport = kAudioDeviceTransportTypeUnknown;
  printf("name=%s\nuid=%s\ntransport=%s\nsample_rate=%.0f\n",
         name ? name.UTF8String : "?", uid ? uid.UTF8String : "?",
         transport_name(transport), (double)rate);
}

static AudioDeviceID resolve(NSString *want) {
  for (NSNumber *boxed in all_devices()) {
    AudioDeviceID dev = (AudioDeviceID)boxed.unsignedIntValue;
    NSString *uid = string_prop(dev, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal);
    if (uid && [uid isEqualToString:want]) return dev;
  }
  for (NSNumber *boxed in all_devices()) {
    AudioDeviceID dev = (AudioDeviceID)boxed.unsignedIntValue;
    NSString *name = string_prop(dev, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
    if (name && [name isEqualToString:want]) return dev;
  }
  for (NSNumber *boxed in all_devices()) {
    AudioDeviceID dev = (AudioDeviceID)boxed.unsignedIntValue;
    NSString *name = string_prop(dev, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
    if (name && [name caseInsensitiveCompare:want] == NSOrderedSame) return dev;
  }
  return kAudioObjectUnknown;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: audio-device list|get|set [in|out] [NAME_OR_UID]\n");
      return 2;
    }
    NSString *cmd = @(argv[1]);
    if ([cmd isEqualToString:@"list"]) {
      for (NSNumber *boxed in all_devices()) {
        AudioDeviceID dev = (AudioDeviceID)boxed.unsignedIntValue;
        NSString *name = string_prop(dev, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
        NSString *uid = string_prop(dev, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal);
        printf("in=%d out=%d name=%s uid=%s\n", has_streams(dev, kAudioDevicePropertyScopeInput) ? 1 : 0,
               has_streams(dev, kAudioDevicePropertyScopeOutput) ? 1 : 0,
               name ? name.UTF8String : "?", uid ? uid.UTF8String : "?");
      }
      return 0;
    }
    if (argc < 3) {
      fprintf(stderr, "usage: audio-device get in|out | set in|out NAME_OR_UID\n");
      return 2;
    }
    BOOL input = strcmp(argv[2], "in") == 0;
    if (!input && strcmp(argv[2], "out") != 0) {
      fprintf(stderr, "audio-device: third argument must be 'in' or 'out'\n");
      return 2;
    }
    if ([cmd isEqualToString:@"get"]) {
      AudioDeviceID dev = default_device(input);
      if (dev == kAudioObjectUnknown) {
        fprintf(stderr, "audio-device: no default %s device\n", argv[2]);
        return 1;
      }
      print_device(dev);
      return 0;
    }
    if ([cmd isEqualToString:@"set"]) {
      if (argc < 4) {
        fprintf(stderr, "audio-device: set needs a device name or uid\n");
        return 2;
      }
      AudioDeviceID dev = resolve(@(argv[3]));
      if (dev == kAudioObjectUnknown) {
        fprintf(stderr, "audio-device: no device matching '%s'\n", argv[3]);
        return 1;
      }
      AudioObjectPropertyAddress addr = {
          input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
          kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      OSStatus st = AudioObjectSetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL,
                                              sizeof(dev), &dev);
      if (st != noErr) {
        fprintf(stderr, "audio-device: set failed: %d\n", (int)st);
        return 1;
      }
      // Read it back: a set that did not take is the failure this tool reports.
      AudioDeviceID now = default_device(input);
      if (now != dev) {
        fprintf(stderr, "audio-device: set did not take\n");
        return 1;
      }
      print_device(now);
      return 0;
    }
    fprintf(stderr, "audio-device: unknown command '%s'\n", argv[1]);
    return 2;
  }
}
