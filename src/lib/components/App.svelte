<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';
	import { gsap } from 'gsap';
	import { Application, Container, Filter, Graphics, UniformGroup } from 'pixi.js';
	import { onMount } from 'svelte';

	interface Props {
		currentTrack?: Track | null;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<MediaElementAudioSourceNode | null>(null);
	let bufferLength = $state(0);
	let dataArray = $state<Uint8Array<ArrayBuffer> | null>(null);
	let canvasEl = $state<HTMLCanvasElement>();
	let xDistance = $state(250);
	let innerWidth = $state(typeof window === 'undefined' ? 393 : window.innerWidth);
	let innerHeight = $state(typeof window === 'undefined' ? 660 : window.innerHeight);
	const maxCirclesDesktop = 80;
	const maxCirclesMobile = 35;
	const maxSpawnPerFrameDesktop = 4;
	const maxSpawnPerFrameMobile = 2;
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

	async function initGraphics() {
		const app = new Application();

		// Detect Safari and use auto preference (falls back to WebGL) for better compatibility
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

		document.body.append(app.canvas as HTMLCanvasElement);
		const container = new Container();
		onResize();
		window.addEventListener('resize', onResize);

		const left = new Graphics();
		const right = new Graphics();
		const circles = new Container();
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
		// Two-pass separable Gaussian blur; noise on second pass only for subtle texture.
		circles.filters = [postFxX, postFxY];

		app.ticker.add(() => {
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
				drawLines(left, right);
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
	function drawLines(left: Graphics, right: Graphics) {
		left.clear();
		right.clear();
		right.x = innerWidth;
		const hue = currentTrack?.hue ?? 150;
		const barHeight = innerHeight / (store.bars / 2);
		const barWidth = innerWidth / 1.5;
		const lineHeight = 1;
		for (let i = 0; i < bufferLength; i++) {
			const h = dataArray?.[i] ?? 0;
			const pct = h / 255;
			const vPct = i / bufferLength;
			const color = `hsl(${Math.round(vPct * hue + hue)}, ${Math.round(vPct * 60 + 40)}%, ${Math.round(vPct * 60 + 25)}%)`;
			const offsetY = Math.round((barHeight - lineHeight) / 2);
			let y = Math.round(i * barHeight);
			const w = barWidth * pct;
			left.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color });
			left.circle(w, y, 3).fill({ color, alpha: pct });
			y += offsetY;
			right.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color, alpha: pct });
			right.circle(w, y, 3).fill({ color, alpha: pct });
		}
	}

	function createCircle(pct: number, width: number, height: number, container: Container) {
		const g = new Graphics();
		const hue = currentTrack?.hue ?? 150;
		const color = `hsl(${Math.round(Math.random() * hue * 1.2 + hue)}, ${Math.round((1 - Math.random()) * 60 + 40)}%, ${Math.round(Math.random() * 30 + 20)}%)`;
		const radius = Math.random() * (isMobile ? 60 : 150) + 5;

		// Draw outer glow ring
		const glowRadius = radius * 1.4;
		g.circle(0, 0, glowRadius).fill({ color, alpha: 0.15 });

		// Draw middle glow ring
		const midGlowRadius = radius * 1.15;
		g.circle(0, 0, midGlowRadius).fill({ color, alpha: 0.3 });

		// Draw main circle
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
			initGraphics();
		}, 100);
	});

	function play() {
		if (music) {
			music.play();
			music.volume = 1;

			if (audioSource && store.audioContext && store.analyser) {
				audioSource.connect(store.analyser);
				store.analyser.connect(store.audioContext.destination);

				bufferLength = store.analyser.frequencyBinCount;
				dataArray = new Uint8Array(bufferLength);
			}
		} else {
			console.log('no music');
		}
	}
	function onPlayTrack(audio: TrackAudio, track: Track) {
		currentTrack = track;
		music?.pause();
		music = audio.audioEl;
		audioSource = audio.audioSource;
		for (const t of tracks) {
			if (t === track) t.isPlaying = true;
			else t.isPlaying = false;
		}
		play();
	}

	function skipToNextTrack() {
		const index = tracks.findIndex((t) => t.id === currentTrack?.id);
		const next = (index + 1) % tracks.length;
		const track = document.querySelector('#track-' + tracks[next].id + ' button');
		if (track) {
			(track as HTMLButtonElement).click();
		}
	}
</script>

<svelte:window bind:innerWidth bind:innerHeight />

<div class="wrap">
	<div class="text">
		<h1>j.Falcon</h1>
		<h2>Undefined</h2>
	</div>
	<div class="list">
		{#each tracks as track (track.id)}
			<TrackComponent
				{track}
				isSelected={track.id === currentTrack?.id}
				on:play={(e) => {
					onPlayTrack(e.detail, track);
				}}
				on:end={() => {
					skipToNextTrack();
				}}
			/>
		{/each}
	</div>
</div>
<canvas bind:this={canvasEl} width="100%" height="100%"></canvas>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		position: relative;
		z-index: 1;
	}
	.list {
		max-width: 440px;
		width: 100%;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	h1 {
		position: relative;
		z-index: 1;
		font-size: 4rem;
		margin: 0;
		line-height: 1;
		font-family: 'Zen Dots';
		text-align: center;
	}
	h2 {
		font-size: 1.5rem;
		font-family: 'Zen Dots';
		width: 320px;
		margin: 0 auto;
		font-weight: 300;
		text-align: right;
		transform: translate(-4%, -30%);
	}
	/* h3 {
		font-size: 1rem;
		font-weight: normal;
		margin: 0 0 60px;
		opacity: 0.75;
	} */
	h1,
	h2 {
		text-shadow: 0 3px 15px rgba(0, 0, 0, 0.5);
	}
	.text {
		color: white;
	}
	@media (min-width: 560px) {
		h1 {
			font-size: 7rem;
		}
		h2 {
			font-size: 3rem;
			transform: translate(-2px, -40%);
			width: 100%;
		}
		/* h3 {
			font-size: 1.25rem;
		} */
	}
	@media (min-width: 900px) {
		h1 {
			font-size: 10rem;
		}
		h2 {
			transform: translate(-5px, -50%);
		}
	}

	canvas {
		position: fixed;
		height: 100vh;
		width: 100%;
		top: 0;
		left: 0;
		z-index: 0;
	}
</style>
