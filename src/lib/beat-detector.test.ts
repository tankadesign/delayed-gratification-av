import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateBeatBand, resolveEffectiveBpm } from './beat-detector.ts';

describe('evaluateBeatBand', () => {
	it('fires again for saturated energy after the cutoff decays', () => {
		const first = evaluateBeatBand({
			energy: 1,
			cutoff: 0.08,
			minEnergy: 0.08,
			threshold: 1.48,
			decayPerSecond: 1.6,
			delta: 0.016,
			nowSeconds: 0,
			lastHitSeconds: -1,
			minIntervalSeconds: 0.12
		});
		assert.equal(first.detected, true);
		assert.equal(first.cutoff, 1.48);

		let cutoff = first.cutoff;
		let secondHit = false;
		for (let i = 0; i < 20; i += 1) {
			const result = evaluateBeatBand({
				energy: 1,
				cutoff,
				minEnergy: 0.08,
				threshold: 1.48,
				decayPerSecond: 1.6,
				delta: 0.016,
				nowSeconds: 0.016 * (i + 1),
				lastHitSeconds: 0,
				minIntervalSeconds: 0.12
			});
			cutoff = result.cutoff;
			secondHit ||= result.detected;
		}

		assert.equal(secondHit, true);
	});

	it('uses a configured track BPM before falling back to auto detection', () => {
		assert.equal(resolveEffectiveBpm(108, 189), 108);
		assert.equal(resolveEffectiveBpm(0, 86), 86);
	});
});
