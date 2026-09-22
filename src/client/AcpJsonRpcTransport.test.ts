import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';

describe('AcpJsonRpcTransport', () => {
  let input: PassThrough;
  let output: PassThrough;
  let transport: AcpJsonRpcTransport;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    transport = new AcpJsonRpcTransport({ input, output }, 50); // small timeout
  });

  afterEach(() => {
    transport.dispose();
  });

  it('start() initializes readline and processes lines', async () => {
    transport.start();
    let handlerCalled = false;
    transport.onNotification('test', () => {
      handlerCalled = true;
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'test' }) + '\n');

    // wait for event loop to process
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(handlerCalled).toBe(true);
  });

  it('request() sends JSON-RPC message and resolves on response', async () => {
    transport.start();

    const requestPromise = transport.request<{ result: string }>('hello', { param: 1 });

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    const parsed = JSON.parse(sentMsg.trim());
    expect(parsed.method).toBe('hello');
    expect(parsed.id).toBeTypeOf('number');

    input.write(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { result: 'ok' } }) + '\n');

    const res = await requestPromise;
    expect(res).toEqual({ result: 'ok' });
  });

  it('request() rejects on timeout', async () => {
    transport.start();

    const requestPromise = transport.request('timeoutMethod', undefined, 10);

    await expect(requestPromise).rejects.toThrow(/timed out/);
  });

  it('request() rejects when transport is disposed', async () => {
    transport.dispose();
    await expect(transport.request('method')).rejects.toThrow('Transport closed');
  });

  it('notify() sends notification without id', async () => {
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.notify('someEvent', { value: 42 });

    await new Promise(resolve => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    expect(parsed.method).toBe('someEvent');
    expect(parsed.id).toBeUndefined();
    expect(parsed.params).toEqual({ value: 42 });
  });

  it('notify() does not send if disposed', async () => {
    transport.dispose();
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.notify('someEvent', { value: 42 });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sentMsg).toBe('');
  });

  it('onNotification() registers handler and receives params', async () => {
    transport.start();

    const handler = vi.fn();
    const unsubscribe = transport.onNotification('myNotification', handler);

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'myNotification', params: { test: true } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledWith({ test: true });

    // test unsubscribe
    unsubscribe();
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'myNotification', params: { test: false } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onRequest() registers handler and sends response', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    const unsubscribe = transport.onRequest('myRequest', async (params) => {
      return { echo: params };
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'myRequest', params: 'hello' }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 20));

    const responses = sentMsg.trim().split('\n').map(l => JSON.parse(l));
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 99, result: { echo: 'hello' } });

    // test unsubscribe — the request now has no handler, so it gets a method-not-found reply
    unsubscribe();
    sentMsg = '';
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'myRequest', params: 'hello2' }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterUnsub = JSON.parse(sentMsg.trim());
    expect(afterUnsub).toEqual({
      jsonrpc: '2.0',
      id: 100,
      error: { code: -32601, message: 'Method not found: myRequest' },
    });
  });

  it('answers unregistered server→client requests with -32601 so the agent does not block', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'unknownMethod', params: {} }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 20));

    const responses = sentMsg.trim().split('\n').map(l => JSON.parse(l));
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 55,
      error: { code: -32601, message: 'Method not found: unknownMethod' },
    });
  });

  it('does not answer unregistered notifications (no id)', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'unknownNotification' }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sentMsg).toBe('');
  });

  it('onRequest() registers handler and sends error when handler rejects', async () => {    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.onRequest('failRequest', async () => {
      throw new Error('Something went wrong');
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'failRequest' }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 20));

    const responses = sentMsg.trim().split('\n').map(l => JSON.parse(l));
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 101, error: { code: -32000, message: 'Something went wrong' } });
  });

  it('dispose() rejects all pending requests', async () => {
    transport.start();

    const req1 = transport.request('m1');
    const req2 = transport.request('m2');

    transport.dispose();

    await expect(req1).rejects.toThrow('Transport closed');
    await expect(req2).rejects.toThrow('Transport closed');
    expect(transport.isClosed).toBe(true);
  });

  it('dispose() handles input close gracefully', async () => {
    transport.start();
    const req1 = transport.request('m1');

    input.end();

    await expect(req1).rejects.toThrow('JSON-RPC input closed');
    expect(transport.isClosed).toBe(true);
  });

  it('handleLine() ignores empty/invalid JSON', async () => {
    transport.start();
    const handler = vi.fn();
    transport.onNotification('test', handler);

    input.write('\n'); // empty
    input.write('   \n'); // whitespace
    input.write('not a json\n');
    input.write('{"jsonrpc": "2.0", "method": "test"}\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handleLine() dispatches to correct handlers', async () => {
    transport.start();

    const p = transport.request('m');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    const reqId = parsed.id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { message: 'Some error' } }) + '\n');

    await expect(p).rejects.toThrow('Some error');
  });

  it('handleLine() ignores unknown errors', async () => {
    transport.start();

    const p = transport.request('m');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    const reqId = parsed.id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: {} }) + '\n');

    await expect(p).rejects.toThrow('Unknown error');
  });

  it('catches and logs output write errors', async () => {
    transport.start();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const badOutput = new PassThrough();
    badOutput.write = () => { throw new Error('Write failed'); };

    const badTransport = new AcpJsonRpcTransport({ input, output: badOutput });

    badTransport.notify('m');

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
