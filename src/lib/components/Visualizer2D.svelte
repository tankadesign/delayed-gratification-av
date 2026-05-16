<script lang="ts">
	import { store } from '$lib/store.svelte';
	import type { Track } from '$lib/types';
	import { gsap } from 'gsap';
	import { Application, Container, Filter, Graphics, UniformGroup } from 'pixi.js';
	import { onDestroy, onMount } from 'svelte';

	interface Props {
		currentTrack?: Track | null;
		music?: HTMLAudioElement | null;
	}

	let { currentTrack = null, music = null }: Props = $props();

	let app: Application | null = null;
	let canvasEl = $state<HTMLCanvasElement>();
	let bufferLength = $state(0);
	let dataArray = $state<Uint8Array<ArrayBuffer> | null>(null);
	let ghostArray = $state<Float32Array | null>(null);
	let xDistance = $state(250);
	let innerWidth = $state(typeof window === 'undefined' ? 393 : window.innerWidth);
	let innerHeight = $state(typeof window === 'undefined' ? 660 : window.innerHeight);
	let resizeHandler: (() => void) | null = null;
	const maxCirclesDesktop = 80;
	const maxCirclesMobile = 35;
	const maxSpawnPerFrameDesktop = 4;
	const maxSpawnPerFrameMobile = 2;
	const lineGhostDecayDesktop = 0.995;
	const lineGhostDecayMobile = 0.995;
	const lineGhostYOffset = 5;

	const filterVertexSource = `in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
		vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

		position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
		position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

		return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
		return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
		gl_Position = filterVertexPosition();
		vTextureCoord = filterTextureCoord();
}`;

	const filterFragmentSource = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uNoise;
uniform float uBlur;
uniform vec2 uTexel;
uniform vec2 uDirection;

float rand(vec2 co)
{
		return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void)
{
		vec2 stepUv = uTexel * uBlur * uDirection;

		// 9-tap 1D Gaussian kernel; run twice (X then Y) for a smoother 2D blur.
		vec4 color = texture(uTexture, vTextureCoord) * 0.227027;
		color += texture(uTexture, vTextureCoord + stepUv * 1.0) * 0.1945946;
		color += texture(uTexture, vTextureCoord - stepUv * 1.0) * 0.1945946;
		color += texture(uTexture, vTextureCoord + stepUv * 2.0) * 0.1216216;
		color += texture(uTexture, vTextureCoord - stepUv * 2.0) * 0.1216216;
		color += texture(uTexture, vTextureCoord + stepUv * 3.0) * 0.054054;
		color += texture(uTexture, vTextureCoord - stepUv * 3.0) * 0.054054;
		color += texture(uTexture, vTextureCoord + stepUv * 4.0) * 0.016216;
		color += texture(uTexture, vTextureCoord - stepUv * 4.0) * 0.016216;
		float n = (rand(gl_FragCoord.xy * 0.013 + uTime * 0.15) - 0.5) * uNoise;

		if (color.a > 0.0) {
				color.rgb /= color.a;
		}

		color.rgb += vec3(n);
		color.rgb *= color.a;
		finalColor = color;
}`;

	const filterWgslSource = `struct GlobalFilterUniforms {
	uInputSize:vec4<f32>,
	uInputPixel:vec4<f32>,
	uInputClamp:vec4<f32>,
	uOutputFrame:vec4<f32>,
	uGlobalFrame:vec4<f32>,
	uOutputTexture:vec4<f32>,
};

struct EtherealUniforms {
	uTime:f32,
	uNoise:f32,
	uBlur:f32,
	uTexel:vec2<f32>,
	uDirection:vec2<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> fxUniforms: EtherealUniforms;

struct VSOutput {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>
};

fn filterVertexPosition(aPosition:vec2<f32>) -> vec4<f32>
{
	var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
	position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
	position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
	return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition:vec2<f32>) -> vec2<f32>
{
	return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
	return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

fn rand(co: vec2<f32>) -> f32 {
	return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn mainFragment(
	@location(0) uv: vec2<f32>,
	@builtin(position) position: vec4<f32>
) -> @location(0) vec4<f32> {
	let stepUv = fxUniforms.uTexel * fxUniforms.uBlur * fxUniforms.uDirection;

	// 9-tap 1D Gaussian kernel; run twice (X then Y) for a smoother 2D blur.
	var color = textureSample(uTexture, uSampler, uv) * 0.227027;
	color += textureSample(uTexture, uSampler, uv + stepUv * 1.0) * 0.1945946;
	color += textureSample(uTexture, uSampler, uv - stepUv * 1.0) * 0.1945946;
	color += textureSample(uTexture, uSampler, uv + stepUv * 2.0) * 0.1216216;
	color += textureSample(uTexture, uSampler, uv - stepUv * 2.0) * 0.1216216;
	color += textureSample(uTexture, uSampler, uv + stepUv * 3.0) * 0.054054;
	color += textureSample(uTexture, uSampler, uv - stepUv * 3.0) * 0.054054;
	color += textureSample(uTexture, uSampler, uv + stepUv * 4.0) * 0.016216;
	color += textureSample(uTexture, uSampler, uv - stepUv * 4.0) * 0.016216;

	let n = (rand(position.xy * 0.013 + fxUniforms.uTime * 0.15) - 0.5) * fxUniforms.uNoise;

	if (color.a > 0.0) {
		color.r /= color.a;
		color.g /= color.a;
		color.b /= color.a;
	}

	color.r += n;
	color.g += n;
	color.b += n;
	color.r *= color.a;
	color.g *= color.a;
	color.b *= color.a;

	return color;
}`;

	let isMobile = $derived(innerWidth < 560);

	function getResolution() {
		const devicePixelRatio = typeof window === 'undefined' ? 2 : window.devicePixelRatio;
		const maxResolution = isMobile ? 1 : 1.25;
		return Math.min(maxResolution, devicePixelRatio);
	}

	function getCanvasSize() {
		const main = document.querySelector('main');
		const size = {
			width: main?.clientWidth ?? window.innerWidth,
			height: main?.clientHeight ?? window.innerHeight
		};
		return size;
	}

	function syncAnalyserData() {
		if (!store.analyser) return;
		const nextBufferLength = store.analyser.frequencyBinCount;
		if (!nextBufferLength || nextBufferLength === bufferLength) return;
		bufferLength = nextBufferLength;
		dataArray = new Uint8Array(bufferLength);
		ghostArray = new Float32Array(bufferLength);
	}

	async function initGraphics() {
		app = new Application();

		const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

		await app.init({
			background: '#002',
			antialias: true,
			resolution: getResolution(),
			canvas: canvasEl,
			width: getCanvasSize().width,
			height: getCanvasSize().height,
			preference: isSafari ? 'webgl' : 'webgpu'
		});
		const stageSize = {
			width: app.screen.width,
			height: app.screen.height
		};
		const fxUniformsX = new UniformGroup({
			uTime: { value: 0, type: 'f32' },
			uNoise: { value: 0, type: 'f32' },
			uBlur: { value: isMobile ? 1.2 : 1.8, type: 'f32' },
			uTexel: {
				value: new Float32Array([
					1 / Math.max(1, stageSize.width),
					1 / Math.max(1, stageSize.height)
				]),
				type: 'vec2<f32>'
			},
			uDirection: {
				value: new Float32Array([1, 0]),
				type: 'vec2<f32>'
			}
		});
		const fxUniformsY = new UniformGroup({
			uTime: { value: 0, type: 'f32' },
			uNoise: { value: isMobile ? 0.12 : 0.2, type: 'f32' },
			uBlur: { value: isMobile ? 1.2 : 1.8, type: 'f32' },
			uTexel: {
				value: new Float32Array([
					1 / Math.max(1, stageSize.width),
					1 / Math.max(1, stageSize.height)
				]),
				type: 'vec2<f32>'
			},
			uDirection: {
				value: new Float32Array([0, 1]),
				type: 'vec2<f32>'
			}
		});
		const onResize = () => {
			if (!app) return;
			const { width, height } = getCanvasSize();
			const safeWidth = Math.max(1, Math.round(width));
			const safeHeight = Math.max(1, Math.round(height));
			app.renderer.resolution = getResolution();
			app.renderer.resize(safeWidth, safeHeight);
			stageSize.width = safeWidth;
			stageSize.height = safeHeight;
			const texelX = fxUniformsX.uniforms.uTexel as Float32Array;
			const texelY = fxUniformsY.uniforms.uTexel as Float32Array;
			texelX[0] = 1 / safeWidth;
			texelX[1] = 1 / safeHeight;
			texelY[0] = texelX[0];
			texelY[1] = texelX[1];
		};

		const container = new Container();
		onResize();
		resizeHandler = onResize;
		window.addEventListener('resize', resizeHandler);

		const lineGhostLayer = new Container();
		const leftGhost = new Graphics();
		const rightGhost = new Graphics();
		lineGhostLayer.y += lineGhostYOffset;
		lineGhostLayer.addChild(leftGhost);
		lineGhostLayer.addChild(rightGhost);
		lineGhostLayer.blendMode = 'add';
		rightGhost.scale.x = -1;

		const left = new Graphics();
		const right = new Graphics();
		const circles = new Container();
		container.addChild(lineGhostLayer);
		container.addChild(circles);
		container.addChild(left);
		container.addChild(right);
		left.blendMode = 'add';
		right.blendMode = 'add';
		right.scale.x = -1;

		app.stage.addChild(container);
		const postFxX = Filter.from({
			gl: {
				vertex: filterVertexSource,
				fragment: filterFragmentSource,
				name: 'ethereal-post-filter'
			},
			gpu: {
				vertex: {
					source: filterWgslSource,
					entryPoint: 'mainVertex'
				},
				fragment: {
					source: filterWgslSource,
					entryPoint: 'mainFragment'
				}
			},
			resources: {
				fxUniforms: fxUniformsX
			}
		});
		const postFxY = Filter.from({
			gl: {
				vertex: filterVertexSource,
				fragment: filterFragmentSource,
				name: 'ethereal-post-filter'
			},
			gpu: {
				vertex: {
					source: filterWgslSource,
					entryPoint: 'mainVertex'
				},
				fragment: {
					source: filterWgslSource,
					entryPoint: 'mainFragment'
				}
			},
			resources: {
				fxUniforms: fxUniformsY
			}
		});
		circles.filters = [postFxX, postFxY];

		app.ticker.add(() => {
			syncAnalyserData();
			fxUniformsX.uniforms.uTime += 0.016;
			fxUniformsY.uniforms.uTime += 0.016;
			if (store.analyser && dataArray) {
				store.analyser.getByteFrequencyData(dataArray);
				xDistance = Math.random() < 0.03 ? 1500 : 250;
				let forceFire = false;
				let canFire = Math.random() < 0.7;
				let spawned = 0;
				const maxCircles = isMobile ? maxCirclesMobile : maxCirclesDesktop;
				const spawnBudget = isMobile ? maxSpawnPerFrameMobile : maxSpawnPerFrameDesktop;
				drawLines(leftGhost, rightGhost, left, right);
				for (let i = 0; i < bufferLength; i++) {
					const h = dataArray[i];
					const pct = h / 255;

					if (i === Math.round(bufferLength * 0.55) && pct > 0.6) {
						xDistance = 1500;
						forceFire = Math.random() < 0.65;
					}

					canFire = canFire && pct > 0.6 && Math.random() < 0.6;
					if (
						(canFire || forceFire) &&
						spawned < spawnBudget &&
						circles.children.length < maxCircles
					) {
						spawned += 1;
						createCircle(pct, stageSize.width, stageSize.height, circles);
					}
				}
			}
		});
	}

	function drawLines(leftGhost: Graphics, rightGhost: Graphics, left: Graphics, right: Graphics) {
		leftGhost.clear();
		rightGhost.clear();
		left.clear();
		right.clear();
		rightGhost.x = innerWidth;
		right.x = innerWidth;
		const hue = currentTrack?.hue ?? 150;
		const lineGhostDecay = isMobile ? lineGhostDecayMobile : lineGhostDecayDesktop;
		const barHeight = innerHeight / (store.bars / 2);
		const barWidth = innerWidth / 1.5;
		const lineHeight = 1;
		for (let i = 0; i < bufferLength; i++) {
			const h = dataArray?.[i] ?? 0;
			const pct = h / 255;
			const prevGhost = ghostArray?.[i] ?? 0;
			const ghostPct = Math.max(pct, prevGhost * lineGhostDecay);
			if (ghostArray) ghostArray[i] = ghostPct;
			const vPct = i / bufferLength;
			const color = `hsl(${Math.round(vPct * hue + hue)}, ${Math.round(vPct * 60 + 40)}%, ${Math.round(vPct * 60 + 25)}%)`;
			const offsetY = Math.round((barHeight - lineHeight) / 2);
			let y = Math.round(i * barHeight);
			const wGhost = barWidth * ghostPct * 0.98;
			const w = barWidth * pct;
			leftGhost.moveTo(0, y).lineTo(wGhost, y).stroke({
				width: lineHeight + 6,
				color,
				alpha: Math.min(0.18, ghostPct * 0.28),
				join: 'round'
			});
			leftGhost.moveTo(0, y).lineTo(wGhost, y).stroke({
				width: lineHeight + 3,
				color,
				alpha: Math.min(0.28, ghostPct * 0.42),
				join: 'round'
			});
			leftGhost.circle(wGhost * 1.1, y, 4).fill({ color, alpha: Math.min(0.2, ghostPct * 0.3) });
			left.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color });
			left.circle(w, y, 3).fill({ color, alpha: pct });
			y += offsetY;
			rightGhost.moveTo(0, y).lineTo(wGhost, y).stroke({
				width: lineHeight + 6,
				color,
				alpha: Math.min(0.18, ghostPct * 0.28),
				join: 'round'
			});
			rightGhost.moveTo(0, y).lineTo(wGhost, y).stroke({
				width: lineHeight + 3,
				color,
				alpha: Math.min(0.28, ghostPct * 0.42),
				join: 'round'
			});
			rightGhost.circle(wGhost * 1.1, y, 4).fill({ color, alpha: Math.min(0.2, ghostPct * 0.3) });
			right.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color });
			right.circle(w, y, 3).fill({ color, alpha: pct });
		}
	}

	function createCircle(pct: number, width: number, height: number, container: Container) {
		const g = new Graphics();
		const hue = currentTrack?.hue ?? 150;
		const color = `hsl(${Math.round(Math.random() * hue * 1.2 + hue)}, ${Math.round((1 - Math.random()) * 60 + 40)}%, ${Math.round(Math.random() * 30 + 20)}%)`;
		const radius = Math.random() * (isMobile ? 60 : 150) + 5;

		const glowRadius = radius * 1.4;
		g.circle(0, 0, glowRadius).fill({ color, alpha: 0.15 });

		const midGlowRadius = radius * 1.15;
		g.circle(0, 0, midGlowRadius).fill({ color, alpha: 0.3 });

		if (Math.random() < 0.2) {
			g.circle(0, 0, radius).fill(color);
		} else {
			g.circle(0, 0, radius).stroke({ width: Math.random() * 2 + 1, color });
		}

		const offsetX = isMobile ? 200 : window.innerWidth * 0.7;
		g.x = Math.random() * offsetX - offsetX * 0.5 + width / 2;
		g.y = window.innerHeight + (Math.random() * 400 - 200);
		g.alpha = Math.random() * 0.3 + 0.6;
		g.blendMode = 'add';

		container.addChild(g);
		gsap.to(g, {
			alpha: 0,
			duration: 3,
			x: window.innerWidth / 2,
			ease: 'quad.in',
			onComplete: () => {
				container.removeChild(g);
			}
		});
		gsap.to(g, {
			alpha: 0,
			duration: 3,
			y: g.y + -0.8 * window.innerHeight,
			ease: 'quart.in'
		});
		gsap.from(g.scale, {
			x: 0.65,
			y: 0.65,
			duration: 3,
			ease: 'expo.out'
		});
		return g;
	}

	onMount(() => {
		setTimeout(() => {
			void initGraphics();
		}, 100);
	});

	onDestroy(() => {
		if (resizeHandler) {
			window.removeEventListener('resize', resizeHandler);
			resizeHandler = null;
		}
		app?.destroy();
		app = null;
	});
</script>

<svelte:window bind:innerWidth bind:innerHeight />

<canvas bind:this={canvasEl} width="100%" height="100%"></canvas>

<style>
	canvas {
		position: fixed;
		height: 100vh;
		width: 100%;
		top: 0;
		left: 0;
		z-index: 0;
	}
</style>
