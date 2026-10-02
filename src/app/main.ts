import { StudioApp } from './StudioApp';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app root missing');
}

void StudioApp.create(root);
