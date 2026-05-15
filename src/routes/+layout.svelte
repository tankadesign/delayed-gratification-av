<script lang="ts">
	import { firebaseConfig } from '$lib/firebase';
	import { store } from '$lib/store.svelte';
	import { getAnalytics } from 'firebase/analytics';
	import { initializeApp } from 'firebase/app';
	import { onMount } from 'svelte';
	import './app.css';
	interface Props {
		children?: import('svelte').Snippet;
	}

	let { children }: Props = $props();

	const app = initializeApp(firebaseConfig);

	onMount(() => {
		const analytics = getAnalytics(app);
		store.ga = analytics;
		store.logEvent('page_view');
	});
</script>

<main>
	{@render children?.()}
</main>

<style>
	main {
		position: relative;
		height: 100vh;
		height: 100svh;
		width: 100vw;
		overflow: hidden;
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
