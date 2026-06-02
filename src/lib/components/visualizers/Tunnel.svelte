<script lang="ts">
	import { dev } from '$app/environment';
	import { store } from '$lib/store.svelte';
	import type { Track, TunnelConfig } from '$lib/types';
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
		Points,
		Scene,
		ShaderMaterial,
		WebGLRenderer
	} from 'three';

	interface Props {
		currentTrack?: Track | null;
		music?: HTMLAudioElement | null;
		freqLow?: number;
		freqHigh?: number;
		isShowingControls?: boolean;
		config?: PartialTunnelConfig;
	}

	interface TunnelSlice {
		mesh: Mesh<BufferGeometry, ShaderMaterial>;
		ghostMesh: Mesh<BufferGeometry, ShaderMaterial>;
		particleLayer: Points<BufferGeometry, ShaderMaterial>;
		positions: Float32Array;
		particlePositions: Float32Array;
		particleSizes: Float32Array;
		color: Color;
		zRotation: number;
		age: number;
		active: boolean;
	}

	type PartialTunnelConfig = {
		[K in keyof TunnelConfig]?: TunnelConfig[K] extends Record<string, number>
			? Partial<TunnelConfig[K]>
			: TunnelConfig[K];
	};

	let {
		currentTrack = null,
		music = null,
		freqLow = 35,
		freqHigh = 14000,
		isShowingControls = false,
		config = {}
	}: Props = $props();

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
	let gapNoiseTime = 0;
	let currentEmitInterval = $state(0);
	let bendNoiseTime = 0;
	let sliceCursor = 0;
	let resizeHandler: (() => void) | null = null;
	let didCopyTunnelConfig = $state(false);

	const initialTunnelConfig: TunnelConfig = {
		slices: 180,
		segments: 290,
		emitIntervalSeconds: 0.45,
		lifetimeSeconds: 10.8,
		depth: 288,
		nearZ: -13.5,
		cameraZ: 2,
		curve: {
			sourceRenderMode: 2,
			ringRadiusDesktop: 6.45,
			ringRadiusMobile: 6.8,
			lineThicknessDesktop: 0.086,
			lineThicknessMobile: 0.078,
			amplitudeDesktop: 16,
			amplitudeMobile: 12,
			baselineY: 2,
			smoothing: 0.2,
			endFade: 0.08,
			morphStrength: 80,
			twist: 8.6
		},
		emission: {
			gapModAmount: 0.4,
			gapModNoiseSpeed: 3.26,
			gapModNoiseContrast: 2.55,
			curvePower: 1,
			zRotationSpeed: 1.31,
			gradientCycleSpeed: 0.08
		},
		ghost: {
			enabled: 1,
			opacity: 0.23,
			scale: 0.92,
			blurWidth: 0.42,
			thicknessMultiplier: 9.45,
			warp: 5.8,
			twistOffset: 0.65,
			zOffset: -2.5
		},
		particle: {
			radius: 0.25,
			count: 300,
			radiusVariability: 0.4,
			randomness: 0.09,
			offset: -1.5,
			moveSpeed: 10
		},
		bend: {
			amount: 250,
			noiseSpeed: 0.325,
			depthStrength: 1.25
		}
	};

	function createTunnelConfig(overrides: PartialTunnelConfig = {}): TunnelConfig {
		return {
			...initialTunnelConfig,
			...overrides,
			curve: { ...initialTunnelConfig.curve, ...overrides.curve },
			emission: { ...initialTunnelConfig.emission, ...overrides.emission },
			ghost: { ...initialTunnelConfig.ghost, ...overrides.ghost },
			particle: { ...initialTunnelConfig.particle, ...overrides.particle },
			bend: { ...initialTunnelConfig.bend, ...overrides.bend }
		};
	}

	let tunnelConfig = $state(createTunnelConfig());

	let currentWave = new Float32Array(initialTunnelConfig.segments + 1);
	let smoothedWave = new Float32Array(initialTunnelConfig.segments + 1);
	let smoothingScratch = new Float32Array(initialTunnelConfig.segments + 1);
	const tunnelSlices: TunnelSlice[] = [];

	let isMobile = $derived(innerWidth < 560);
	let renderMode = $derived(
		tunnelConfig.curve.sourceRenderMode === 0
			? 'Curves'
			: tunnelConfig.curve.sourceRenderMode === 1
				? 'Particles'
				: 'Curves + Particles'
	);

	const tunnelVertexShader = `
		attribute float aT;
		attribute float aSide;
		uniform float uTime;
		uniform float uAge;
		uniform float uMorphStrength;
		uniform float uTwist;
		uniform float uWarpStrength;
		uniform float uTwistOffset;
		uniform float uThicknessBoost;
		varying float vT;
		varying float vSide;
		varying float vAge;

		void main() {
			vT = aT;
			vSide = aSide;
			vAge = uAge;

			vec3 p = position;
			vec2 radial = normalize(p.xy + vec2(0.0001));
			p.xy += radial * aSide * uThicknessBoost;
			float centered = aT - 0.5;
			float waveA = sin(centered * 18.0 + uTime * 1.7 + uAge * 7.0);
			float waveB = sin(centered * 41.0 - uTime * 0.9 + uAge * 11.0);
			float ageEase = smoothstep(0.0, 1.0, uAge);
			p.x += waveA * (uMorphStrength + uWarpStrength) * ageEase * 0.22;
			p.y += waveB * (uMorphStrength + uWarpStrength) * ageEase * 0.22;

			float ghostWarp = sin(aT * 29.0 + uTime * 0.8 + uAge * 15.0) * uWarpStrength * ageEase;
			p.xy += normalize(vec2(p.y + 0.001, -p.x + 0.001)) * ghostWarp * 0.18;

			float twist = centered * uTwist * ageEase + uTwistOffset + sin(uTime * 0.18 + uAge * 6.283) * 0.12;
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
		uniform float uOpacity;
		uniform float uBlurWidth;
		uniform float uEndFade;
		varying float vT;
		varying float vSide;
		varying float vAge;

		void main() {
			float side = abs(vSide);
			float crispEdge = 1.0 - smoothstep(0.35, 1.0, side);
			float sigma = max(0.001, 0.18 + uBlurWidth * 0.9);
			float gaussianEdge = exp(-(side * side) / (2.0 * sigma * sigma));
			float edge = mix(crispEdge, gaussianEdge * 0.68, smoothstep(0.001, 0.18, uBlurWidth));
			float fade = smoothstep(1.0, 0.03, vAge);
			float endFade = smoothstep(0.0, uEndFade, vT) * smoothstep(1.0, 1.0 - uEndFade, vT);
			float centerGlow = 1.0 - abs(vT - 0.5) * 1.35;
			vec3 color = uColorA;
			color = mix(color, vec3(1.0), clamp(uPulse * 0.32 + centerGlow * 0.1, 0.0, 0.45));
			float alpha = edge * fade * endFade * mix(0.16, 1.0, 1.0 - vAge);
			gl_FragColor = vec4(color, alpha * uOpacity);
		}
	`;

	const particleVertexShader = `
		attribute float aSize;
		uniform float uPixelRatio;
		uniform float uAge;
		varying float vAge;

		void main() {
			vAge = uAge;
			vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
			gl_Position = projectionMatrix * mvPosition;
			gl_PointSize = aSize * uPixelRatio * (180.0 / max(1.0, -mvPosition.z));
		}
	`;

	const particleFragmentShader = `
		uniform vec3 uColor;
		uniform float uOpacity;
		varying float vAge;

		void main() {
			vec2 uv = gl_PointCoord - 0.5;
			float d = length(uv);
			float circle = 1.0 - smoothstep(0.34, 0.5, d);
			float fade = smoothstep(1.0, 0.03, vAge);
			gl_FragColor = vec4(uColor, circle * fade * uOpacity);
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
		return isMobile ? tunnelConfig.curve.ringRadiusMobile : tunnelConfig.curve.ringRadiusDesktop;
	}

	function getLineThickness() {
		return isMobile
			? tunnelConfig.curve.lineThicknessMobile
			: tunnelConfig.curve.lineThicknessDesktop;
	}

	function getAmplitude() {
		return isMobile ? tunnelConfig.curve.amplitudeMobile : tunnelConfig.curve.amplitudeDesktop;
	}

	function rebuildWaveBuffers() {
		currentWave = new Float32Array(tunnelConfig.segments + 1);
		smoothedWave = new Float32Array(tunnelConfig.segments + 1);
		smoothingScratch = new Float32Array(tunnelConfig.segments + 1);
		setupTunnelSlices();
	}

	type ConfigPath =
		| keyof Pick<
				TunnelConfig,
				| 'slices'
				| 'segments'
				| 'emitIntervalSeconds'
				| 'lifetimeSeconds'
				| 'depth'
				| 'nearZ'
				| 'cameraZ'
		  >
		| `curve.${keyof TunnelConfig['curve']}`
		| `emission.${keyof TunnelConfig['emission']}`
		| `ghost.${keyof TunnelConfig['ghost']}`
		| `particle.${keyof TunnelConfig['particle']}`
		| `bend.${keyof TunnelConfig['bend']}`;

	function getTunnelNumber(path: ConfigPath) {
		const parts = String(path).split('.');
		let value: unknown = tunnelConfig;
		for (const part of parts) {
			value = (value as Record<string, unknown>)[part];
		}
		return typeof value === 'number' ? value : 0;
	}

	function setTunnelNumber(path: ConfigPath, value: string | number, rebuild = false) {
		const nextValue = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(nextValue)) return;
		const parts = String(path).split('.');
		let target = tunnelConfig as unknown as Record<string, unknown>;
		for (let i = 0; i < parts.length - 1; i++) {
			target = target[parts[i]] as Record<string, unknown>;
		}
		target[parts[parts.length - 1]] = nextValue;
		if (rebuild) rebuildWaveBuffers();
		if (path === 'cameraZ' && camera) {
			camera.position.z = tunnelConfig.cameraZ;
			camera.lookAt(0, 0, -30);
		}
	}

	function resetTunnelConfig() {
		tunnelConfig = createTunnelConfig(config);
		if (camera) {
			camera.position.z = tunnelConfig.cameraZ;
			camera.lookAt(0, 0, -30);
		}
		rebuildWaveBuffers();
	}

	async function copyTunnelConfig() {
		const configSource = `const initialTunnelConfig = ${JSON.stringify(tunnelConfig, null, '\t')};`;
		await navigator.clipboard.writeText(configSource);
		didCopyTunnelConfig = true;
		setTimeout(() => {
			didCopyTunnelConfig = false;
		}, 1200);
	}

	function noiseHash(n: number) {
		const value = Math.sin(n * 127.1) * 43758.5453123;
		return value - Math.floor(value);
	}

	function valueNoise1D(x: number) {
		const i = Math.floor(x);
		const f = x - i;
		const u = f * f * (3 - 2 * f);
		return MathUtils.lerp(noiseHash(i), noiseHash(i + 1), u);
	}

	function contrastNoise(value: number, contrast: number) {
		const centered = (value - 0.5) * Math.max(0, contrast);
		return MathUtils.clamp(centered + 0.5, 0, 1);
	}

	function updateEmitInterval(delta: number) {
		gapNoiseTime += delta * tunnelConfig.emission.gapModNoiseSpeed;
		const gapNoise = contrastNoise(
			valueNoise1D(gapNoiseTime),
			tunnelConfig.emission.gapModNoiseContrast
		);
		const centeredNoise = gapNoise * 2 - 1;
		const modulationWidth = Math.max(0, tunnelConfig.emission.gapModAmount);
		currentEmitInterval = Math.max(
			0.005,
			tunnelConfig.emitIntervalSeconds + centeredNoise * modulationWidth
		);
	}

	function getBendOffset(age: number) {
		const depthWeight = Math.pow(MathUtils.clamp(age, 0, 1), tunnelConfig.bend.depthStrength);
		const bendX = (valueNoise1D(bendNoiseTime + age * 0.85) - 0.5) * 2;
		const bendY = (valueNoise1D(bendNoiseTime + 91.7 + age * 0.85) - 0.5) * 2;
		return {
			x: bendX * tunnelConfig.bend.amount * depthWeight,
			y: bendY * tunnelConfig.bend.amount * depthWeight
		};
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

	function sampleTunnelGradient(t: number) {
		const stops = currentTrack?.gradientStops?.length
			? currentTrack.gradientStops
			: ['#ff184c', '#1887ff'];
		if (stops.length === 1) return new Color(stops[0]);
		const wrapped = ((t % 1) + 1) % 1;
		const scaled = wrapped * stops.length;
		const index = Math.floor(scaled) % stops.length;
		const nextIndex = (index + 1) % stops.length;
		return new Color(stops[index]).lerp(new Color(stops[nextIndex]), scaled - Math.floor(scaled));
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

		const smoothing = MathUtils.clamp(tunnelConfig.curve.smoothing, 0, 0.995);
		const temporalAlpha = MathUtils.lerp(1, 0.04, smoothing);

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
			currentWave[i] = tunnelConfig.curve.baselineY + shaped * amplitude;
			smoothedWave[i] = MathUtils.lerp(smoothedWave[i], currentWave[i], temporalAlpha);
		}

		const spatialPasses = Math.round(smoothing * 10);
		for (let pass = 0; pass < spatialPasses; pass++) {
			smoothingScratch.set(smoothedWave);
			for (let i = 0; i <= tunnelConfig.segments; i++) {
				const prev = i === 0 ? tunnelConfig.segments : i - 1;
				const next = i === tunnelConfig.segments ? 0 : i + 1;
				smoothedWave[i] =
					smoothingScratch[prev] * 0.22 +
					smoothingScratch[i] * 0.56 +
					smoothingScratch[next] * 0.22;
			}
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

	function createParticleGeometry() {
		const count = Math.max(0, Math.floor(tunnelConfig.particle.count));
		const positions = new Float32Array(count * 3);
		const sizes = new Float32Array(count);
		const geometry = new BufferGeometry();
		const positionAttribute = new BufferAttribute(positions, 3);
		const sizeAttribute = new BufferAttribute(sizes, 1);
		positionAttribute.setUsage(DynamicDrawUsage);
		sizeAttribute.setUsage(DynamicDrawUsage);
		geometry.setAttribute('position', positionAttribute);
		geometry.setAttribute('aSize', sizeAttribute);
		return { geometry, positions, sizes };
	}

	function createParticleMaterial() {
		return new ShaderMaterial({
			vertexShader: particleVertexShader,
			fragmentShader: particleFragmentShader,
			uniforms: {
				uPixelRatio: { value: getPixelRatio() },
				uAge: { value: 1 },
				uColor: { value: new Color(0xffffff) },
				uOpacity: { value: 1 }
			},
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: AdditiveBlending
		});
	}

	function createTunnelMaterial(isGhost = false) {
		const { a, b } = sampleGradientStops();
		return new ShaderMaterial({
			vertexShader: tunnelVertexShader,
			fragmentShader: tunnelFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uAge: { value: 1 },
				uMorphStrength: { value: tunnelConfig.curve.morphStrength },
				uTwist: { value: tunnelConfig.curve.twist },
				uWarpStrength: { value: isGhost ? tunnelConfig.ghost.warp : 0 },
				uTwistOffset: { value: isGhost ? tunnelConfig.ghost.twistOffset : 0 },
				uThicknessBoost: {
					value: isGhost
						? getLineThickness() *
							(tunnelConfig.ghost.thicknessMultiplier - 1 + tunnelConfig.ghost.blurWidth * 18)
						: 0
				},
				uColorA: { value: a },
				uColorB: { value: b },
				uPulse: { value: 0 },
				uOpacity: { value: isGhost ? tunnelConfig.ghost.opacity : 1 },
				uBlurWidth: { value: isGhost ? tunnelConfig.ghost.blurWidth : 0 },
				uEndFade: { value: tunnelConfig.curve.endFade }
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
			scene.remove(slice.ghostMesh);
			scene.remove(slice.particleLayer);
			slice.mesh.geometry.dispose();
			slice.mesh.material.dispose();
			slice.ghostMesh.material.dispose();
			slice.particleLayer.geometry.dispose();
			slice.particleLayer.material.dispose();
		}
		tunnelSlices.length = 0;
		sliceCursor = 0;

		for (let i = 0; i < tunnelConfig.slices; i++) {
			const { geometry, positions } = createTunnelGeometry();
			const {
				geometry: particleGeometry,
				positions: particlePositions,
				sizes: particleSizes
			} = createParticleGeometry();
			const material = createTunnelMaterial();
			const ghostMaterial = createTunnelMaterial(true);
			const particleMaterial = createParticleMaterial();
			const mesh = new Mesh(geometry, material);
			const ghostMesh = new Mesh(geometry, ghostMaterial);
			const particleLayer = new Points(particleGeometry, particleMaterial);
			mesh.frustumCulled = false;
			ghostMesh.frustumCulled = false;
			particleLayer.frustumCulled = false;
			mesh.visible = false;
			ghostMesh.visible = false;
			particleLayer.visible = false;
			ghostMesh.renderOrder = -1;
			mesh.renderOrder = 1;
			particleLayer.renderOrder = 2;
			scene.add(ghostMesh);
			scene.add(mesh);
			scene.add(particleLayer);
			tunnelSlices.push({
				mesh,
				ghostMesh,
				particleLayer,
				positions,
				particlePositions,
				particleSizes,
				color: new Color(0xffffff),
				zRotation: 0,
				age: 1,
				active: false
			});
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

	function sampleSmoothedWave(t: number) {
		const wrapped = ((t % 1) + 1) % 1;
		const scaled = wrapped * tunnelConfig.segments;
		const index0 = Math.floor(scaled);
		const index1 = (index0 + 1) % tunnelConfig.segments;
		return MathUtils.lerp(smoothedWave[index0], smoothedWave[index1], scaled - index0);
	}

	function writeSliceParticles(slice: TunnelSlice) {
		const ringRadius = getRingRadius();
		const randomness = MathUtils.clamp(tunnelConfig.particle.randomness, 0, 1);
		const sizeBase = Math.max(0, tunnelConfig.particle.radius);
		const sizeVariance = Math.max(0, tunnelConfig.particle.radiusVariability);
		const particleCount = Math.max(0, Math.floor(tunnelConfig.particle.count));
		for (let i = 0; i < particleCount; i++) {
			const evenT = particleCount <= 1 ? 0 : i / particleCount;
			const randomT = Math.random();
			const t = MathUtils.lerp(evenT, randomT, randomness);
			const angle = t * Math.PI * 2;
			const radius = ringRadius + sampleSmoothedWave(t) + tunnelConfig.particle.offset;
			const offset = i * 3;
			slice.particlePositions[offset] = Math.cos(angle) * radius;
			slice.particlePositions[offset + 1] = Math.sin(angle) * radius;
			slice.particlePositions[offset + 2] = 0;
			slice.particleSizes[i] = Math.max(
				0,
				sizeBase + MathUtils.lerp(-sizeVariance, sizeVariance, Math.random())
			);
		}
		slice.particleLayer.geometry.attributes.position.needsUpdate = true;
		slice.particleLayer.geometry.attributes.aSize.needsUpdate = true;
		slice.particleLayer.geometry.computeBoundingSphere();
	}

	function emitTunnelSlice() {
		const slice = tunnelSlices[sliceCursor];
		if (!slice) return;
		writeSliceGeometry(slice);
		writeSliceParticles(slice);
		slice.color.copy(sampleTunnelGradient(timeSeconds * tunnelConfig.emission.gradientCycleSpeed));
		slice.zRotation = timeSeconds * tunnelConfig.emission.zRotationSpeed;
		slice.age = 0;
		slice.active = true;
		slice.mesh.visible =
			tunnelConfig.curve.sourceRenderMode === 0 || tunnelConfig.curve.sourceRenderMode === 2;
		slice.particleLayer.visible =
			tunnelConfig.curve.sourceRenderMode === 1 || tunnelConfig.curve.sourceRenderMode === 2;
		slice.ghostMesh.visible = tunnelConfig.ghost.enabled > 0;
		slice.mesh.position.set(0, 0, tunnelConfig.nearZ);
		slice.particleLayer.position.set(0, 0, tunnelConfig.nearZ);
		slice.ghostMesh.position.set(0, 0, tunnelConfig.nearZ + tunnelConfig.ghost.zOffset);
		slice.mesh.rotation.set(0, 0, 0);
		slice.particleLayer.rotation.set(0, 0, 0);
		slice.ghostMesh.rotation.set(0, 0, 0);
		sliceCursor = (sliceCursor + 1) % tunnelSlices.length;
	}

	function updateTunnel(delta: number) {
		const pulse = dataArray
			? Math.max(...dataArray.slice(0, Math.min(dataArray.length, 24))) / 255
			: 0;

		for (const slice of tunnelSlices) {
			if (!slice.active) continue;
			slice.age += delta / tunnelConfig.lifetimeSeconds;
			if (slice.age >= 1) {
				slice.active = false;
				slice.mesh.visible = false;
				slice.particleLayer.visible = false;
				slice.ghostMesh.visible = false;
				continue;
			}

			const age = slice.age;
			const curvedAge = Math.pow(age, Math.max(0.05, tunnelConfig.emission.curvePower));
			const z = tunnelConfig.nearZ - curvedAge * tunnelConfig.depth;
			const scale = 0.84 + curvedAge * curvedAge * 4.9;
			const bend = getBendOffset(age);
			const sourceUsesCurves =
				tunnelConfig.curve.sourceRenderMode === 0 || tunnelConfig.curve.sourceRenderMode === 2;
			const sourceUsesParticles =
				tunnelConfig.curve.sourceRenderMode === 1 || tunnelConfig.curve.sourceRenderMode === 2;
			slice.mesh.visible = sourceUsesCurves;
			slice.particleLayer.visible = sourceUsesParticles;
			slice.mesh.position.x = bend.x;
			slice.mesh.position.y = bend.y;
			slice.mesh.position.z = z;
			slice.particleLayer.position.x = bend.x;
			slice.particleLayer.position.y = bend.y;
			slice.particleLayer.position.z =
				z + tunnelConfig.particle.moveSpeed * age * tunnelConfig.lifetimeSeconds;
			slice.mesh.scale.setScalar(scale);
			slice.particleLayer.scale.setScalar(scale);
			slice.mesh.rotation.z =
				age * tunnelConfig.curve.twist +
				slice.zRotation +
				Math.sin(timeSeconds * 0.24 + age * 10) * 0.35;
			slice.particleLayer.rotation.z = slice.mesh.rotation.z;
			slice.ghostMesh.visible = tunnelConfig.ghost.enabled > 0;
			slice.ghostMesh.position.x = bend.x;
			slice.ghostMesh.position.y = bend.y;
			slice.ghostMesh.position.z = z + tunnelConfig.ghost.zOffset;
			slice.ghostMesh.scale.setScalar(scale * tunnelConfig.ghost.scale);
			slice.ghostMesh.rotation.z =
				slice.mesh.rotation.z +
				tunnelConfig.ghost.twistOffset +
				Math.sin(timeSeconds * 0.31 + age * 12) * 0.22;
			slice.mesh.material.uniforms.uTime.value = timeSeconds;
			slice.mesh.material.uniforms.uAge.value = age;
			slice.mesh.material.uniforms.uMorphStrength.value = tunnelConfig.curve.morphStrength;
			slice.mesh.material.uniforms.uTwist.value = tunnelConfig.curve.twist;
			slice.mesh.material.uniforms.uColorA.value.copy(slice.color);
			slice.mesh.material.uniforms.uColorB.value.copy(slice.color);
			slice.mesh.material.uniforms.uPulse.value = pulse;
			slice.mesh.material.uniforms.uEndFade.value = tunnelConfig.curve.endFade;
			slice.particleLayer.material.uniforms.uPixelRatio.value = getPixelRatio();
			slice.particleLayer.material.uniforms.uAge.value = age;
			slice.particleLayer.material.uniforms.uColor.value.copy(slice.color);
			slice.particleLayer.material.uniforms.uOpacity.value = 1;
			slice.ghostMesh.material.uniforms.uTime.value = timeSeconds;
			slice.ghostMesh.material.uniforms.uAge.value = age;
			slice.ghostMesh.material.uniforms.uMorphStrength.value = tunnelConfig.curve.morphStrength;
			slice.ghostMesh.material.uniforms.uTwist.value = tunnelConfig.curve.twist;
			slice.ghostMesh.material.uniforms.uWarpStrength.value = tunnelConfig.ghost.warp;
			slice.ghostMesh.material.uniforms.uTwistOffset.value = tunnelConfig.ghost.twistOffset;
			slice.ghostMesh.material.uniforms.uThicknessBoost.value =
				getLineThickness() *
				(tunnelConfig.ghost.thicknessMultiplier - 1 + tunnelConfig.ghost.blurWidth * 18);
			slice.ghostMesh.material.uniforms.uColorA.value.copy(slice.color);
			slice.ghostMesh.material.uniforms.uColorB.value.copy(slice.color);
			slice.ghostMesh.material.uniforms.uPulse.value = pulse;
			slice.ghostMesh.material.uniforms.uOpacity.value = tunnelConfig.ghost.opacity;
			slice.ghostMesh.material.uniforms.uBlurWidth.value = tunnelConfig.ghost.blurWidth;
			slice.ghostMesh.material.uniforms.uEndFade.value = tunnelConfig.curve.endFade;
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
		bendNoiseTime += delta * tunnelConfig.bend.noiseSpeed;
		updateEmitInterval(delta);
		syncAnalyserData();

		if (store.analyser && dataArray) {
			store.analyser.getByteFrequencyData(dataArray);
			readWaveform();
		}

		if (music && !music.paused && dataArray) {
			emitCarry += delta;
			while (emitCarry >= currentEmitInterval) {
				emitTunnelSlice();
				emitCarry -= currentEmitInterval;
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
			scene?.remove(slice.ghostMesh);
			slice.mesh.geometry.dispose();
			slice.mesh.material.dispose();
			slice.ghostMesh.material.dispose();
		}
		tunnelSlices.length = 0;
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
	}

	onMount(() => {
		tunnelConfig = createTunnelConfig(config);
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
	key: ConfigPath,
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
				value={getTunnelNumber(key)}
				oninput={(event) => setTunnelNumber(key, event.currentTarget.value, rebuild)}
			/>
			<input
				class="tunnel-number"
				type="number"
				{step}
				value={getTunnelNumber(key)}
				onchange={(event) => setTunnelNumber(key, event.currentTarget.value, rebuild)}
			/>
		</div>
	</label>
{/snippet}

{#if isShowingControls}
	<div class="tunnel-controls">
		<div class="tunnel-controls-panel">
			<div class="tunnel-controls-header">
				<strong>Shader Settings</strong>
				<div class="tunnel-controls-actions">
					{#if dev}
						<button type="button" onclick={copyTunnelConfig}>
							{didCopyTunnelConfig ? 'Copied' : 'Copy'}
						</button>
					{/if}
					<button type="button" onclick={resetTunnelConfig}>Reset</button>
				</div>
			</div>
			<div class="tunnel-controls-scroll">
				{@render rangeControl('Slices', 'slices', 12, 180, 1, true)}
				{@render rangeControl('Segments', 'segments', 24, 360, 1, true)}
				{@render rangeControl(`Mode: ${renderMode}`, 'curve.sourceRenderMode', 0, 2, 1)}
				{#if tunnelConfig.curve.sourceRenderMode > 0}
					{@render rangeControl('Particle count', 'particle.count', 0, 600, 1, true)}
					{@render rangeControl('Particle radius', 'particle.radius', 0, 24, 0.1)}
					{@render rangeControl(
						'Particle radius variability',
						'particle.radiusVariability',
						0,
						24,
						0.1
					)}
					{@render rangeControl('Particle randomness', 'particle.randomness', 0, 1, 0.01)}
					{@render rangeControl('Particle offset', 'particle.offset', -12, 12, 0.05)}
					{@render rangeControl('Particle move speed', 'particle.moveSpeed', -5, 5, 0.05)}
				{/if}
				{@render rangeControl('Emit gap', 'emitIntervalSeconds', 0.01, 0.25, 0.005)}
				<div class="tunnel-readout">Animated gap {currentEmitInterval.toFixed(3)}s</div>
				{@render rangeControl('Gap modulation width', 'emission.gapModAmount', 0, 0.5, 0.005)}
				{@render rangeControl('Gap modulation speed', 'emission.gapModNoiseSpeed', 0, 5, 0.01)}
				{@render rangeControl('Gap noise contrast', 'emission.gapModNoiseContrast', 0.1, 8, 0.05)}
				{@render rangeControl('Lifetime', 'lifetimeSeconds', 0.8, 12, 0.1)}
				{@render rangeControl('Emission curve', 'emission.curvePower', 0.05, 5, 0.05)}
				{@render rangeControl('Depth', 'depth', 20, 360, 1)}
				{@render rangeControl('Near Z', 'nearZ', -30, 2, 0.1)}
				{@render rangeControl('Camera Z', 'cameraZ', 2, 30, 0.1)}
				{@render rangeControl('Z rotation speed', 'emission.zRotationSpeed', -4, 4, 0.01)}
				{@render rangeControl('Gradient cycle speed', 'emission.gradientCycleSpeed', -2, 2, 0.01)}
				{@render rangeControl('Radius desktop', 'curve.ringRadiusDesktop', 0.2, 14, 0.05)}
				{@render rangeControl('Radius mobile', 'curve.ringRadiusMobile', 0.2, 8, 0.05)}
				{@render rangeControl('Thickness desktop', 'curve.lineThicknessDesktop', 0.002, 0.3, 0.002)}
				{@render rangeControl('Thickness mobile', 'curve.lineThicknessMobile', 0.002, 0.2, 0.002)}
				{@render rangeControl('Amplitude desktop', 'curve.amplitudeDesktop', 0, 20, 0.05)}
				{@render rangeControl('Amplitude mobile', 'curve.amplitudeMobile', 0, 20, 0.05)}
				{@render rangeControl('Baseline', 'curve.baselineY', -4, 4, 0.05)}
				{@render rangeControl('Smoothing', 'curve.smoothing', 0, 0.98, 0.01)}
				{@render rangeControl('Curve end fade', 'curve.endFade', 0, 0.5, 0.005)}
				{@render rangeControl('Morph', 'curve.morphStrength', 0, 120, 0.05)}
				{@render rangeControl('Twist', 'curve.twist', -12, 12, 0.1)}
				{@render rangeControl('Ghost on', 'ghost.enabled', 0, 1, 1)}
				{@render rangeControl('Ghost opacity', 'ghost.opacity', 0, 1, 0.01)}
				{@render rangeControl('Ghost scale', 'ghost.scale', 0.8, 1.4, 0.005)}
				{@render rangeControl('Ghost blur', 'ghost.blurWidth', 0, 1.2, 0.01)}
				{@render rangeControl('Ghost thickness', 'ghost.thicknessMultiplier', 0, 12, 0.05)}
				{@render rangeControl('Ghost warp', 'ghost.warp', 0, 6, 0.05)}
				{@render rangeControl('Ghost twist offset', 'ghost.twistOffset', -4, 4, 0.05)}
				{@render rangeControl('Ghost Z offset', 'ghost.zOffset', -20, 20, 0.1)}
				{@render rangeControl('Bend amount', 'bend.amount', 0, 300, 0.1)}
				{@render rangeControl('Bend speed', 'bend.noiseSpeed', 0, 1, 0.005)}
				{@render rangeControl('Bend depth strength', 'bend.depthStrength', 0, 4, 0.05)}
			</div>
		</div>
	</div>
{/if}

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
		left: 12px;
		z-index: 4;
		width: min(360px, calc(100vw - 24px));
		color: white;
		font-family: system-ui, sans-serif;
		font-size: 12px;
	}

	.tunnel-controls button {
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: transparent;
		color: white;
		padding: 4px 10px;
		cursor: pointer;
	}

	.tunnel-controls-panel {
		max-height: min(72vh, 420px);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.75);
		backdrop-filter: blur(24px);
		padding: 10px;
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 8px;
	}

	.tunnel-controls-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 2px;
	}

	.tunnel-controls-actions {
		display: flex;
		gap: 6px;
	}

	.tunnel-controls-header button {
		border-radius: 5px;
		padding: 5px 8px;
	}

	.tunnel-control {
		display: grid;
		gap: 4px;
	}

	.tunnel-readout {
		padding: 5px 0 20px;
		color: #ff00bf;
	}

	.tunnel-control-row {
		display: grid;
		grid-template-columns: 1fr 76px;
		gap: 32px;
		align-items: center;
	}

	.tunnel-control input[type='range'] {
		width: 100%;
	}

	.tunnel-control input[type='number'] {
		color: white;
	}

	.tunnel-controls-scroll {
		overflow: auto;
	}

	.tunnel-number {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 0;
		background: rgba(255, 255, 255, 0.08);
		padding: 4px 5px;
		font-size: 12px;
		font-weight: bold;
		font-family: var(--monospace);
	}
</style>
