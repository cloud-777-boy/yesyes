class DeterministicRandom {
    constructor(seed = 0x6d2b79f5) {
        this.state = seed >>> 0;
    }

    nextUint() {
        let x = this.state;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.state = x >>> 0;
        return this.state;
    }

    nextFloat() {
        return (this.nextUint() >>> 8) / 0x01000000;
    }

    nextRange(min, max) {
        return min + this.nextFloat() * (max - min);
    }

    nextInt(maxExclusive) {
        if (maxExclusive <= 0) return 0;
        return Math.floor(this.nextFloat() * maxExclusive);
    }

    nextBool() {
        return (this.nextUint() & 1) === 0;
    }

    fork(label = '') {
        let hash = 2166136261 >>> 0;
        for (let i = 0; i < label.length; i++) {
            hash ^= label.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= this.nextUint();
        hash >>>= 0;
        if (hash === 0) hash = 0x9e3779b9;
        return new DeterministicRandom(hash);
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.DeterministicRandom = DeterministicRandom;
}
