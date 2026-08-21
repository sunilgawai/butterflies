import { ButterflyExperience } from './experience/ButterflyExperience.js';

const canvas = document.querySelector('#stage');
const status = document.querySelector('#status');

async function boot() {
  const experience = new ButterflyExperience(canvas);

  try {
    await experience.start();
  } catch (error) {
    console.error(error);
    status.textContent = 'This browser cannot start WebGPU or WebGL 2.';
    status.classList.add('is-error');
    return;
  }

  document.body.classList.add('is-ready');

  // Fades out on its own; after that the swarm is the instruction.
  status.textContent = 'move your cursor through them';
  setTimeout(() => status.classList.add('is-hidden'), 6000);

  // Live tuning without a reload: swarm.config.HOLD_DURATION = 4
  window.swarm = experience;
}

boot();
