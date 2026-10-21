export type { PlannedSlide, Slide, Toolkit } from './slideshow.ts';
export {
  findToolkit,
  HEIGHT,
  makeSlideshow,
  planSlides,
  slideshowArgs,
  WIDTH,
  wrapCaption,
} from './slideshow.ts';
export type { ImageType, MediaStore, MediaType, StoredImage, StoredMedia } from './store.ts';
export {
  createMediaStore,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  sniffImage,
  VIDEO_TYPE,
} from './store.ts';
