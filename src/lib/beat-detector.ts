export interface BeatBandInput {
	energy: number;
	cutoff: number;
	minEnergy: number;
	threshold: number;
	decayPerSecond: number;
	delta: number;
	nowSeconds: number;
	lastHitSeconds: number;
	minIntervalSeconds: number;
}

export interface BeatBandResult {
	detected: boolean;
	cutoff: number;
}

export function evaluateBeatBand(input: BeatBandInput): BeatBandResult {
	const floor = Math.max(0, input.minEnergy);
	const decayedCutoff = Math.max(
		floor,
		input.cutoff - Math.max(0, input.decayPerSecond) * Math.max(0, input.delta)
	);
	const hasWaited =
		input.lastHitSeconds <= 0 ||
		input.nowSeconds - input.lastHitSeconds >= input.minIntervalSeconds;
	const detected = input.energy >= floor && input.energy > decayedCutoff && hasWaited;

	return {
		detected,
		cutoff: detected ? input.energy * Math.max(1, input.threshold) : decayedCutoff
	};
}

export function resolveEffectiveBpm(targetBpm: number, estimatedBpm: number) {
	return targetBpm > 0 ? targetBpm : estimatedBpm;
}
