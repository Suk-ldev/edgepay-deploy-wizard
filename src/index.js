import { route } from './router.js';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return new Response(JSON.stringify({ error: '内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
