import { describe, expect, it } from 'vitest';
import { handlers, processJob } from './processor.js';

describe('processJob', () => {
  it('rejects unknown job types', async () => {
    await expect(processJob('nope', {})).rejects.toThrow('Unknown job type');
  });

  it('rejects known types with no handler yet', async () => {
    await expect(processJob('book.export', {})).rejects.toThrow('No handler');
  });

  it('dispatches to a registered handler', async () => {
    handlers['book.review'] = async (data) => ({ echoed: data });
    await expect(processJob('book.review', 1)).resolves.toEqual({ echoed: 1 });
    delete handlers['book.review'];
  });
});
