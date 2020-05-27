'use strict';

const EventEmitter = require('events');
const { Readable: ReadableStream, PassThrough: PassThroughStream } = require('stream');
const prism = require('prism-media');
const VideoDispatcher = require('../dispatcher/VideoDispatcher');
const dgram = require('dgram');
const ChildProcess = require('child_process');
const path = require('path')

const FFMPEG_ARGS = {
  VP8: [
    '-an',
    '-c:v', 'libvpx',
    '-b:v', 'BITRATE',
    '-cpu-used', '2',
    '-deadline', 'realtime',
    '-f', 'rtp',
    'OUTPUT_URL',
  ],
  VP9: [
    '-an',
    '-c:v', 'libvpx-vp9',
    '-b:v', 'BITRATE',
    '-cpu-used', '2',
    '-deadline', 'realtime',
    '-strict', 'experimental',
    '-f', 'rtp',
    'OUTPUT_URL',
  ],
  H264: [
    '-an',
    '-c:v', 'libopenh264',
    '-b:v', 'BITRATE',
    '-pix_fmt', 'yuv420p',
    '-f', 'rtp',
    'OUTPUT_URL',
  ],
  opus: [
    '-vn',
    '-ar', '48000',
    '-af', "pan=stereo|FL < 1.0*FL + 0.707*FC + 0.707*BL|FR < 1.0*FR + 0.707*FC + 0.707*BR",
    '-c:a', 'libopus',
    '-f', 'rtp',
    'OUTPUT_URL'
  ]
}
const MTU = 1400
const IMAGE_EXTS = [".jpg", ".png", ".jpeg", ".gif"]

/**
 * A Video Player for a Voice Connection.
 * @private
 * @extends {EventEmitter}
 */
class VideoPlayer extends EventEmitter {
  constructor(voiceConnection) {
    super();
    this.voiceConnection = voiceConnection;

    this.dispatcher = null;

    this.streamingData = {
      channels: 2,
      sequence: 0,
      timestamp: 0,
    };
  }

  destroy() {
    if (this.ffmpeg) this.ffmpeg.kill()
    this.destroyDispatcher();
  }

  destroyDispatcher() {
    if (this.dispatcher) {
      this.dispatcher.destroy();
      this.dispatcher = null;
    }
  }

  async playVideo(resource, { bitrate = "1M", volume = 1.0, listen = false, audio = true } = {}) {
    await this.voiceConnection.resetVideoContext()
    const isStream = resource instanceof ReadableStream;
    if (!FFMPEG_ARGS.hasOwnProperty(this.voiceConnection.videoCodec)) {
      console.error(`[PLAY VIDEO ERROR] Codec ${this.voiceConnection.videoCodec} not supported`)
      return
    }

    this.dispatcher = this.createDispatcher()

    const server = dgram.createSocket('udp4');
    const streams = audio ? {
      audioStream: new PassThroughStream()
    } : {}
    server.on('error', (err) => {
      server.close();
      throw err
    });

    server.on('message', (buffer) => {
      const payloadType = buffer[1] & 0b1111111
      if (payloadType === 96 && this.dispatcher) this.dispatcher.write(buffer)
      if (payloadType === 97 && audio) streams.audioStream.write(buffer.slice(12))
    });

    server.on('listening', () => {
      const address = server.address();
    });

    let port = 41234
    while (port < 41240) {
      try {
        server.bind(port);
        break
      } catch {
        port++
      }
    }
    if (port === 41240) {
      console.error(`[PLAY VIDEO ERROR] Could not bind to any UDP port on 41234-41240`)
      return
    }
    const resourceUri = isStream ? "-" : resource
    const isImage = isStream ? false : IMAGE_EXTS.includes(path.parse(resource).ext)

    let args = ['-re', '-i', resourceUri, ...FFMPEG_ARGS[this.voiceConnection.videoCodec], ...((!isImage && audio) ? FFMPEG_ARGS.opus : [])]

    if (isImage) args.unshift('-loop', '1')
    if (listen) args.unshift('-listen', '1')

    let i = -1
    while ((i = args.indexOf("OUTPUT_URL")) > -1) {
      args[i] = `rtp://127.0.0.1:${port}/?pkt_size=${MTU}`
    }

    while ((i = args.indexOf("BITRATE")) > -1) {
      args[i] = `${bitrate}`
    }

    this.voiceConnection.emit('debug', `Launching FFMPEG: ${prism.FFmpeg.getInfo().command} ${args.join(" ")}`)

    this.ffmpeg = ChildProcess.spawn(prism.FFmpeg.getInfo().command, args, {windowsHide: true});
    if (isStream) {
      streams.resource = resource;
      resource.pipe(this.ffmpeg.stdin);
    }
    this.ffmpeg.on('exit', () => {
      server.close()
      streams.audioStream.destroy()
      if (isStream) streams.resource.destroy()
      this.ffmpeg = null
      this.emit('finish')
    })
    return audio ? {
      video: this.dispatcher,
      audio: this.voiceConnection.play(streams.audioStream, {type: 'opus', volume})
    } : { video: this.dispatcher }
  }

  createDispatcher() {
    this.destroyDispatcher();
    const dispatcher = (this.dispatcher = new VideoDispatcher(this));
    return dispatcher;
  }
}

module.exports = VideoPlayer;
