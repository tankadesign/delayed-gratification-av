import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from '@typescript-eslint/eslint-plugin';
import svelteParser from 'svelte-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
	{
		ignores: ['.svelte-kit/**', 'build/**', 'dist/**', 'node_modules/**']
	},
	{
		languageOptions: {
			ecmaVersion: 2020,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},
	js.configs.recommended,
	...tseslint.configs['flat/recommended'],
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2020,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser,
				extraFileExtensions: ['.svelte']
			}
		}
	},
	prettier
];
