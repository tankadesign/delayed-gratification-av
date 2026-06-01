<script lang="ts">
	import { store } from '$lib/store.svelte';
	import type { Track } from '$lib/types';
	import { onDestroy, onMount } from 'svelte';
	import {
		AdditiveBlending,
		BufferAttribute,
		BufferGeometry,
		Color,
		DoubleSide,
		DynamicDrawUsage,
		MathUtils,
		Mesh,
		PerspectiveCamera,
		Scene,
		ShaderMaterial,
		WebGLRenderer
	} from 'three';

	interface Props {
		currentTrack?: Track | null;
		music?: HTMLAudioElement | null;
		freqLow?: number;
		freqHigh?: number;
	}

	interface TunnelSlice {
		mesh: Mesh<BufferGeometry, ShaderMaterial>;
		positions: Float32Array;
		age: number;
		active: boolean;
	}

	let { currentTrack = null, music = null, freqLow = 35, freqHigh = 14000 }: Props = $props();

	let canvasEl = $state<HTMLCanvasElement>();
	let innerWidth = $state(typeof window === 'undefined' ? 393 : window.innerWidth);
	let innerHeight = $state(typeof window === 'undefined' ? 660 : window.innerHeight);
	let bufferLength = $state(0);
	let dataArray = $state<Uint8Array<ArrayBuffer> | null>(null);

	let renderer: WebGLRenderer | null = null;
	let scene: Scene | null = null;
	let camera: PerspectiveCamera | null = null;
	let animationFrameId = 0;
	let previousFrameTime = 0;
	let timeSeconds = 0;
	let emitCarry = 0;
	let sliceCursor = 0;
	let resizeHandler: (() => void) | null = null;
	let showTunnelControls = $state(true);

	const initialTunnelConfig = {
		slices: 180,
		segments: 350,
		emitIntervalSeconds: 0.105,
		lifetimeSeconds: 10.4,
		depth: 288,
		nearZ: -13.5,
		cameraZ: 2,
		ringRadiusDesktop: 6,
		ringRadiusMobile: 2.35,
		lineThicknessDesktop: 0.068,
		lineThicknessMobile: 0.024,
		amplitudeDesktop: 8,
		amplitudeMobile: 1.45,
		baselineY: 4,
		smoothing: 0,
		morphStrength: 0,
		tunnelTwist: 1.6
	};

	let tunnelConfig = $state({ ...initialTunnelConfig });

	let currentWave = new Float32Array(initialTunnelConfig.segments + 1);
	let smoothedWave = new Float32Array(initialTunnelConfig.segments + 1);
	const tunnelSlices: TunnelSlice[] = [];

	let isMobile = $derived(innerWidth < 560);

	const tunnelVertexShader = `
		attribute float aT;
		attribute float aSide;
		uniform float uTime;
		uniform float uAge;
		uniform float uMorphStrength;
		uniform float uTwist;
		varying float vT;
		varying float vSide;
		varying float vAge;

		void main() {
			vT = aT;
			vSide = aSide;
			vAge = uAge;

			vec3 p = position;
			float centered = aT - 0.5;
			float waveA = sin(centered * 18.0 + uTime * 1.7 + uAge * 7.0);
			float waveB = sin(centered * 41.0 - uTime * 0.9 + uAge * 11.0);
			float ageEase = smoothstep(0.0, 1.0, uAge);
			p.x += waveA * uMorphStrength * ageEase * 0.22;
			p.y += waveB * uMorphStrength * ageEase * 0.22;

			float twist = centered * uTwist * ageEase + sin(uTime * 0.18 + uAge * 6.283) * 0.12;
			float c = cos(twist);
			float s = sin(twist);
			p.xy = mat2(c, -s, s, c) * p.xy;

			gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
		}
	`;

	const tunnelFragmentShader = `
		uniform vec3 uColorA;
		uniform vec3 uColorB;
		uniform float uPulse;
		varying float vT;
		varying float vSide;
		varying float vAge;

		void main() {
			float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
			float fade = smoothstep(1.0, 0.03, vAge);
			float centerGlow = 1.0 - abs(vT - 0.5) * 1.35;
			vec3 color = mix(uColorA, uColorB, vT);
			color = mix(color, vec3(1.0), clamp(uPulse * 0.32 + centerGlow * 0.1, 0.0, 0.45));
			float alpha = edge * fade * mix(0.16, 1.0, 1.0 - vAge);
			gl_FragColor = vec4(color, alpha);
		}
	`;

	function getCanvasSize() {
		const main = document.querySelector('main');
		return {
			width: Math.max(1, Math.round(main?.clientWidth ?? window.innerWidth)),
			height: Math.max(1, Math.round(main?.clientHeight ?? window.innerHeight))
		};
	}

	function getPixelRatio() {
		const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
		return Math.min(isMobile ? 1.1 : 1.5, dpr);
	}

	function getRingRadius() {
		return isMobile ? tunnelConfig.ringRadiusMobile : tunnelConfig.ringRadiusDesktop;
	}

	function getLineThickness() {
		return isMobile ? tunnelConfig.lineThicknessMobile : tunnelConfig.lineThicknessDesktop;
	}

	function getAmplitude() {
		return isMobile ? tunnelConfig.amplitudeMobile : tunnelConfig.amplitudeDesktop;
	}

	function rebuildWaveBuffers() {
		currentWave = new Float32Array(tunnelConfig.segments + 1);
		smoothedWave = new Float32Array(tunnelConfig.segments + 1);
		setupTunnelSlices();
	}

	function setTunnelNumber(
		key: keyof typeof tunnelConfig,
		value: string | number,
		rebuild = false
	) {
		const nextValue = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(nextValue)) return;
		tunnelConfig[key] = nextValue;
		if (rebuild) rebuildWaveBuffers();
		if (key === 'cameraZ' && camera) {
			camera.position.z = tunnelConfig.cameraZ;
			camera.lookAt(0, 0, -30);
		}
	}

	function resetTunnelConfig() {
		tunnelConfig = { ...initialTunnelConfig };
		if (camera) {
			camera.position.z = tunnelConfig.cameraZ;
			camera.lookAt(0, 0, -30);
		}
		rebuildWaveBuffers();
	}

	function syncAnalyserData() {
		if (!store.analyser) return;
		const nextBufferLength = store.analyser.frequencyBinCount;
		if (!nextBufferLength || nextBufferLength === bufferLength) return;
		bufferLength = nextBufferLength;
		dataArray = new Uint8Array(bufferLength);
	}

	function sampleGradientStops() {
		const stops = currentTrack?.gradientStops?.length
			? currentTrack.gradientStops
			: ['#ff184c', '#1887ff'];
		return {
			a: new Color(stops[0]),
			b: new Color(stops[Math.max(0, stops.length - 1)])
		};
	}

	function readWaveform() {
		if (!dataArray || !bufferLength) {
			currentWave.fill(0);
			return;
		}

		const sampleRate = store.audioContext?.sampleRate ?? 48000;
		const nyquist = sampleRate / 2;
		const lowIdx = Math.max(0, Math.round((freqLow / nyquist) * bufferLength));
		const highIdx = Math.min(bufferLength, Math.round((freqHigh / nyquist) * bufferLength));
		const bandSize = Math.max(1, highIdx - lowIdx);
		const amplitude = getAmplitude();

		for (let i = 0; i <= tunnelConfig.segments; i++) {
			const t = i / tunnelConfig.segments;
			const centerIdx = lowIdx + Math.floor(t * bandSize);
			const radius = Math.max(1, Math.floor(bandSize / tunnelConfig.segments));
			const start = Math.max(lowIdx, centerIdx - radius);
			const end = Math.min(highIdx, centerIdx + radius + 1);
			let total = 0;
			let peak = 0;
			let count = 0;
			for (let j = start; j < end; j++) {
				const sample = dataArray[j] ?? 0;
				total += sample;
				peak = Math.max(peak, sample);
				count += 1;
			}
			const avgPct = count ? total / (count * 255) : 0;
			const peakPct = peak / 255;
			const pct = Math.min(1, avgPct * 0.45 + peakPct * 0.95);
			const shaped = Math.pow(Math.max(0, pct - 0.04) / 0.96, 0.58);
			currentWave[i] = tunnelConfig.baselineY + shaped * amplitude;
			smoothedWave[i] = MathUtils.lerp(smoothedWave[i], currentWave[i], 1 - tunnelConfig.smoothing);
		}
	}

	function createTunnelGeometry() {
		const vertexCount = (tunnelConfig.segments + 1) * 2;
		const positions = new Float32Array(vertexCount * 3);
		const tValues = new Float32Array(vertexCount);
		const sideValues = new Float32Array(vertexCount);
		const indices: number[] = [];

		for (let i = 0; i <= tunnelConfig.segments; i++) {
			const base = i * 2;
			const t = i / tunnelConfig.segments;
			tValues[base] = t;
			tValues[base + 1] = t;
			sideValues[base] = -1;
			sideValues[base + 1] = 1;
			if (i < tunnelConfig.segments) {
				const a = base;
				const b = base + 1;
				const c = base + 2;
				const d = base + 3;
				indices.push(a, c, b, b, c, d);
			}
		}

		const geometry = new BufferGeometry();
		const positionAttribute = new BufferAttribute(positions, 3);
		positionAttribute.setUsage(DynamicDrawUsage);
		geometry.setAttribute('position', positionAttribute);
		geometry.setAttribute('aT', new BufferAttribute(tValues, 1));
		geometry.setAttribute('aSide', new BufferAttribute(sideValues, 1));
		geometry.setIndex(indices);
		return { geometry, positions };
	}

	function createTunnelMaterial() {
		const { a, b } = sampleGradientStops();
		return new ShaderMaterial({
			vertexShader: tunnelVertexShader,
			fragmentShader: tunnelFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uAge: { value: 1 },
				uMorphStrength: { value: tunnelConfig.morphStrength },
				uTwist: { value: tunnelConfig.tunnelTwist },
				uColorA: { value: a },
				uColorB: { value: b },
				uPulse: { value: 0 }
			},
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: AdditiveBlending,
			side: DoubleSide
		});
	}

	function setupTunnelSlices() {
		if (!scene) return;
		for (const slice of tunnelSlices) {
			scene.remove(slice.mesh);
			slice.mesh.geometry.dispose();
			slice.mesh.material.dispose();
		}
		tunnelSlices.length = 0;
		sliceCursor = 0;

		for (let i = 0; i < tunnelConfig.slices; i++) {
			const { geometry, positions } = createTunnelGeometry();
			const material = createTunnelMaterial();
			const mesh = new Mesh(geometry, material);
			mesh.frustumCulled = false;
			mesh.visible = false;
			scene.add(mesh);
			tunnelSlices.push({ mesh, positions, age: 1, active: false });
		}
	}

	function writeSliceGeometry(slice: TunnelSlice) {
		const ringRadius = getRingRadius();
		const halfThickness = getLineThickness();
		for (let i = 0; i <= tunnelConfig.segments; i++) {
			const t = i / tunnelConfig.segments;
			const angle = t * Math.PI * 2;
			const waveRadius = ringRadius + smoothedWave[i];
			const innerRadius = Math.max(0.05, waveRadius - halfThickness);
			const outerRadius = waveRadius + halfThickness;
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const offset = i * 6;
			slice.positions[offset] = cos * innerRadius;
			slice.positions[offset + 1] = sin * innerRadius;
			slice.positions[offset + 2] = 0;
			slice.positions[offset + 3] = cos * outerRadius;
			slice.positions[offset + 4] = sin * outerRadius;
			slice.positions[offset + 5] = 0;
		}
		slice.mesh.geometry.attributes.position.needsUpdate = true;
		slice.mesh.geometry.computeBoundingSphere();
	}

	function emitTunnelSlice() {
		const slice = tunnelSlices[sliceCursor];
		if (!slice) return;
		writeSliceGeometry(slice);
		slice.age = 0;
		slice.active = true;
		slice.mesh.visible = true;
		slice.mesh.position.set(0, 0, tunnelConfig.nearZ);
		slice.mesh.rotation.set(0, 0, 0);
		sliceCursor = (sliceCursor + 1) % tunnelSlices.length;
	}

	function updateTunnel(delta: number) {
		const { a, b } = sampleGradientStops();
		const pulse = dataArray
			? Math.max(...dataArray.slice(0, Math.min(dataArray.length, 24))) / 255
			: 0;

		for (const slice of tunnelSlices) {
			if (!slice.active) continue;
			slice.age += delta / tunnelConfig.lifetimeSeconds;
			if (slice.age >= 1) {
				slice.active = false;
				slice.mesh.visible = false;
				continue;
			}

			const age = slice.age;
			const z = tunnelConfig.nearZ - age * tunnelConfig.depth;
			const scale = 0.84 + age * age * 4.9;
			slice.mesh.position.z = z;
			slice.mesh.scale.setScalar(scale);
			slice.mesh.rotation.z =
				age * tunnelConfig.tunnelTwist + Math.sin(timeSeconds * 0.24 + age * 10) * 0.35;
			slice.mesh.material.uniforms.uTime.value = timeSeconds;
			slice.mesh.material.uniforms.uAge.value = age;
			slice.mesh.material.uniforms.uColorA.value.copy(a);
			slice.mesh.material.uniforms.uColorB.value.copy(b);
			slice.mesh.material.uniforms.uPulse.value = pulse;
		}
	}

	function onResize() {
		if (!renderer || !camera) return;
		const { width, height } = getCanvasSize();
		renderer.setPixelRatio(getPixelRatio());
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}

	function initThree() {
		if (!canvasEl) return;
		const { width, height } = getCanvasSize();
		renderer = new WebGLRenderer({
			canvas: canvasEl,
			antialias: true,
			alpha: false,
			powerPreference: 'high-performance'
		});
		renderer.setClearColor('#02030a', 1);
		renderer.setPixelRatio(getPixelRatio());
		renderer.setSize(width, height, false);

		scene = new Scene();
		camera = new PerspectiveCamera(isMobile ? 58 : 52, width / height, 0.1, 180);
		camera.position.set(0, 0, tunnelConfig.cameraZ);
		camera.lookAt(0, 0, -30);

		setupTunnelSlices();
		resizeHandler = onResize;
		window.addEventListener('resize', resizeHandler);
		animationFrameId = requestAnimationFrame(animateFrame);
	}

	function animateFrame(now: number) {
		const delta = previousFrameTime ? Math.min(0.05, (now - previousFrameTime) / 1000) : 1 / 60;
		previousFrameTime = now;
		timeSeconds += delta;
		syncAnalyserData();

		if (store.analyser && dataArray) {
			store.analyser.getByteFrequencyData(dataArray);
			readWaveform();
		}

		if (music && !music.paused && dataArray) {
			emitCarry += delta;
			while (emitCarry >= tunnelConfig.emitIntervalSeconds) {
				emitTunnelSlice();
				emitCarry -= tunnelConfig.emitIntervalSeconds;
			}
		} else {
			emitCarry = 0;
		}

		updateTunnel(delta);
		renderer?.render(scene!, camera!);
		animationFrameId = requestAnimationFrame(animateFrame);
	}

	function cleanupThree() {
		cancelAnimationFrame(animationFrameId);
		if (resizeHandler) {
			window.removeEventListener('resize', resizeHandler);
			resizeHandler = null;
		}
		for (const slice of tunnelSlices) {
			scene?.remove(slice.mesh);
			slice.mesh.geometry.dispose();
			slice.mesh.material.dispose();
		}
		tunnelSlices.length = 0;
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
	}

	onMount(() => {
		initThree();
	});

	onDestroy(() => {
		cleanupThree();
	});
</script>

<svelte:window bind:innerWidth bind:innerHeight />

<canvas bind:this={canvasEl} width="100%" height="100%"></canvas>

{#snippet rangeControl(
	label: string,
	key: keyof typeof tunnelConfig,
	min: number,
	max: number,
	step: number,
	rebuild = false
)}
	<label class="tunnel-control">
		<span>{label}</span>
		<div class="tunnel-control-row">
			<input
				type="range"
				{min}
				{max}
				{step}
				value={tunnelConfig[key]}
				oninput={(event) => setTunnelNumber(key, event.currentTarget.value, rebuild)}
			/>
			<input
				class="tunnel-number"
				type="number"
				{min}
				{max}
				{step}
				value={tunnelConfig[key]}
				onchange={(event) => setTunnelNumber(key, event.currentTarget.value, rebuild)}
			/>
		</div>
	</label>
{/snippet}

<div class="tunnel-controls" class:collapsed={!showTunnelControls}>
	<button
		class="tunnel-controls-toggle"
		type="button"
		onclick={() => (showTunnelControls = !showTunnelControls)}
	>
		{showTunnelControls ? 'Hide 3D_02 Controls' : 'Show 3D_02 Controls'}
	</button>
	{#if showTunnelControls}
		<div class="tunnel-controls-panel">
			<div class="tunnel-controls-header">
				<strong>Tunnel Shader</strong>
				<button type="button" onclick={resetTunnelConfig}>Reset</button>
			</div>
			{@render rangeControl('Slices', 'slices', 12, 180, 1, true)}
			{@render rangeControl('Segments', 'segments', 24, 360, 1, true)}
			{@render rangeControl('Emit gap', 'emitIntervalSeconds', 0.01, 0.25, 0.005)}
			{@render rangeControl('Lifetime', 'lifetimeSeconds', 0.8, 12, 0.1)}
			{@render rangeControl('Depth', 'depth', 20, 360, 1)}
			{@render rangeControl('Near Z', 'nearZ', -30, 2, 0.1)}
			{@render rangeControl('Camera Z', 'cameraZ', 2, 30, 0.1)}
			{@render rangeControl('Radius desktop', 'ringRadiusDesktop', 0.2, 14, 0.05)}
			{@render rangeControl('Radius mobile', 'ringRadiusMobile', 0.2, 8, 0.05)}
			{@render rangeControl('Thickness desktop', 'lineThicknessDesktop', 0.002, 0.3, 0.002)}
			{@render rangeControl('Thickness mobile', 'lineThicknessMobile', 0.002, 0.2, 0.002)}
			{@render rangeControl('Amplitude desktop', 'amplitudeDesktop', 0, 8, 0.05)}
			{@render rangeControl('Amplitude mobile', 'amplitudeMobile', 0, 5, 0.05)}
			{@render rangeControl('Baseline', 'baselineY', -4, 4, 0.05)}
			{@render rangeControl('Smoothing', 'smoothing', 0, 0.98, 0.01)}
			{@render rangeControl('Morph', 'morphStrength', 0, 4, 0.05)}
			{@render rangeControl('Twist', 'tunnelTwist', -12, 12, 0.1)}
		</div>
	{/if}
</div>

<style>
	canvas {
		position: fixed;
		height: 100vh;
		width: 100%;
		top: 0;
		left: 0;
		z-index: 0;
	}

	.tunnel-controls {
		position: fixed;
		top: 12px;
		right: 12px;
		z-index: 4;
		width: min(360px, calc(100vw - 24px));
		color: white;
		font-family: system-ui, sans-serif;
		font-size: 12px;
	}

	.tunnel-controls-toggle,
	.tunnel-controls button {
		border: 1px solid rgba(255, 255, 255, 0.24);
		background: rgba(4, 5, 16, 0.78);
		color: white;
		padding: 7px 10px;
		cursor: pointer;
	}

	.tunnel-controls-toggle {
		width: 100%;
		border-radius: 6px;
	}

	.tunnel-controls-panel {
		margin-top: 8px;
		max-height: min(72vh, 760px);
		overflow: auto;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 8px;
		background: rgba(3, 4, 14, 0.84);
		backdrop-filter: blur(10px);
		padding: 10px;
		display: grid;
		gap: 8px;
	}

	.tunnel-controls-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 2px;
	}

	.tunnel-controls-header button {
		border-radius: 5px;
		padding: 5px 8px;
	}

	.tunnel-control {
		display: grid;
		gap: 4px;
	}

	.tunnel-control span {
		color: rgba(255, 255, 255, 0.78);
	}

	.tunnel-control-row {
		display: grid;
		grid-template-columns: 1fr 76px;
		gap: 8px;
		align-items: center;
	}

	.tunnel-control input[type='range'] {
		width: 100%;
	}

	.tunnel-number {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		padding: 4px 5px;
	}
</style>
