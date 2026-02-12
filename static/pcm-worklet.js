// In: Float32 PCM at AudioContext sampleRate (often 48k)
// Out (postMessage): ArrayBuffer of Int16 little-endian PCM at 16,000 Hz
class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inSampleRate = sampleRate; // context rate
    this.outSampleRate = (options.processorOptions && options.processorOptions.targetSampleRate) || 16000;
    this._buffer = [];
    this._ratio = this.inSampleRate / this.outSampleRate;
    this._carry = 0; // for fractional stepping
  }

  static get parameterDescriptors() { return []; }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0]; // mono expected (we requested channelCount:1)
    if (!ch0) return true;

    // Downsample using simple fractional-step (linear interpolation)
    const inData = ch0;
    const outLen = Math.floor((inData.length + this._carry) / this._ratio);
    const out = new Int16Array(outLen);
    let i = -this._carry; // start with negative offset if we had carry
    for (let n = 0; n < outLen; n++) {
      const idx = i;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const s0 = inData[i0] || 0;
      const s1 = inData[i0 + 1] || s0;
      const sample = s0 + (s1 - s0) * frac; // linear interp
      // float32 [-1,1] -> int16
      let s = Math.max(-1, Math.min(1, sample));
      out[n] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
      i += this._ratio;
    }
    // keep leftover fractional position for next block
    const consumed = outLen * this._ratio;
    this._carry = (consumed - Math.floor(consumed));

    // Post to main thread as transferable ArrayBuffer
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm16-worklet", PCM16Worklet);
