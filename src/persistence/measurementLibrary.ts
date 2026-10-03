/**
 * Compatibility shim. Measurement sets are now **avatars** (see
 * `avatarLibrary.ts`): a 2D avatar is measurements only, a 3D avatar also owns a
 * generated mesh + SDF. Existing call sites keep their old names.
 */
export {
  loadAvatarLibrary as loadMeasurementLibrary,
  saveAvatarLibrary as saveMeasurementLibrary,
  cachedAvatarLibrary as cachedMeasurementLibrary,
  addAvatar as addMeasurementSet,
  duplicateAvatar as duplicateMeasurementSet,
  removeAvatar as removeMeasurementSet,
  updateAvatar as updateMeasurementSet,
  setActiveAvatar as setActiveMeasurementSet,
} from './avatarLibrary';
