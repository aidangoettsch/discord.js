'use strict';

const EventEmitter = require('events');
const { Readable: ReadableStream, PassThrough: PassThroughStream } = require('stream');
const prism = require('prism-media');
const VideoDispatcher = require('../dispatcher/VideoDispatcher');
const dgram = require('dgram');
const ChildProcess = require('child_process');

const FFMPEG_ARGS = {
  VP8: [
    '-an',
    '-c:v', 'libvpx',
    '-b:v', '1M',
    '-cpu-used', '2',
    '-deadline', 'realtime',
    '-f', 'rtp',
    'OUTPUT_URL',
    '-vn',
    '-ar', '48000',
    '-af', "pan=stereo|FL < 1.0*FL + 0.707*FC + 0.707*BL|FR < 1.0*FR + 0.707*FC + 0.707*BR",
    '-c:a', 'libopus',
    '-f', 'rtp',
    'OUTPUT_URL'
  ],
  H264: [
    '-an',
    '-c:v', 'libx264',
    '-b:v', '1M',
    '-pix_fmt', 'yuv420p',
    '-f', 'rtp',
    'OUTPUT_URL',
    '-vn',
    '-ar', '48000',
    '-af', "pan=stereo|FL < 1.0*FL + 0.707*FC + 0.707*BL|FR < 1.0*FR + 0.707*FC + 0.707*BR",
    '-c:a', 'libopus',
    '-f', 'rtp',
    'OUTPUT_URL'
  ]
}
const MTU = 1400

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
    this.destroyDispatcher();
  }

  destroyDispatcher() {
    if (this.dispatcher) {
      this.dispatcher.destroy();
      this.dispatcher = null;
    }
  }

  playVideo(resource, options) {
    if (!FFMPEG_ARGS.hasOwnProperty(this.voiceConnection.videoCodec)) {
      console.error(`[PLAY VIDEO ERROR] Codec ${this.voiceConnection.videoCodec} not supported`)
      return
    }

    this.dispatcher = this.createDispatcher()

    const server = dgram.createSocket('udp4');
    const streams = {
      audioStream: new PassThroughStream()
    };
    server.on('error', (err) => {
      server.close();
      throw err
    });

    server.on('message', (buffer) => {
      const payloadType = buffer[1] & 0b1111111
      if (payloadType === 96) this.dispatcher.write(buffer)
      if (payloadType === 97) streams.audioStream.write(buffer.slice(12))
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
    const isStream = resource instanceof ReadableStream;
    const resourceUri = isStream ? "-" : resource

    let args = ['-re', '-i', resourceUri, ...FFMPEG_ARGS[this.voiceConnection.videoCodec]]

    let i = -1
    while ((i = args.indexOf("OUTPUT_URL")) > -1) {
      args[i] = `rtp://127.0.0.1:${port}/?pkt_size=${MTU}`
    }

    const ffmpeg = ChildProcess.spawn(prism.FFmpeg.getInfo().command, args, { windowsHide: true });
    if (isStream) {
      streams.resource = resource;
      resource.pipe(ffmpeg.stdin);
    }
    this.voiceConnection.play(streams.audioStream, {type: 'opus'})
  }

  createDispatcher() {
    this.destroyDispatcher();
    const dispatcher = (this.dispatcher = new VideoDispatcher(this));
    return dispatcher;
  }
}

module.exports = VideoPlayer;
