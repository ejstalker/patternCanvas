import { StudioApp } from './StudioApp';
import { installNumberInputWheel } from '../utils/numberInputWheel';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app root missing');
}

// Alt+wheel nudges any number field that has focus, wherever it lives.
installNumberInputWheel();

void StudioApp.create(root);
