import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex';

describe('Mutex', () => {
	it('executes simple function', async () => {
		const mutex = new Mutex();
		const result = await mutex.runExclusive(async () => {
			return 42;
		});
		expect(result).toBe(42);
	});

	it('executes concurrently queued tasks sequentially', async () => {
		const mutex = new Mutex();
		const results: number[] = [];

		const task1 = mutex.runExclusive(async () => {
			await new Promise(r => setTimeout(r, 10));
			results.push(1);
			return 1;
		});

		const task2 = mutex.runExclusive(async () => {
			results.push(2);
			return 2;
		});

		const task3 = mutex.runExclusive(async () => {
			await new Promise(r => setTimeout(r, 5));
			results.push(3);
			return 3;
		});

		await Promise.all([task1, task2, task3]);

		expect(results).toEqual([1, 2, 3]);
	});

	it('releases lock when task throws error', async () => {
		const mutex = new Mutex();
		const results: number[] = [];

		const task1 = mutex.runExclusive(async () => {
			throw new Error('Test error');
		}).catch(() => 'caught');

		const task2 = mutex.runExclusive(async () => {
			results.push(2);
			return 2;
		});

		await Promise.all([task1, task2]);

		expect(results).toEqual([2]);
	});
});
