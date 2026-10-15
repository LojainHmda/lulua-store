export interface HeroSlide {
  type: "video" | "image";
  src?: string;
  imageId?: string;
  // Optional — only ever set when an admin picks an existing product's
  // video as the hero (auto-filled from that product's own photo), so the
  // video area shows a real frame immediately instead of a blank/black one
  // while the video itself is still fetching. Absent on every slide saved
  // before this existed, and on plain image slides.
  poster?: string;
  alt: string;
  badge?: string;
  badgeAr?: string;
  title?: string;
  titleAr?: string;
}

export const HERO_SLIDES: HeroSlide[] = [
  {
    type: "video",
    src: "https://videos.pexels.com/video-files/9512045/9512045-uhd_2732_1440_25fps.mp4",
    alt: "Model walking the runway",
  },
  {
    type: "image",
    imageId: "1619086303291-0ef7699e4b31",
    alt: "Woman wearing a camel coat and white trousers",
  },
  {
    type: "video",
    src: "https://videos.pexels.com/video-files/7223711/7223711-uhd_1440_2560_25fps.mp4",
    alt: "Woman walking a city street in a tailored coat",
  },
  {
    type: "image",
    imageId: "1716004354896-8b84c7f08b8b",
    alt: "Woman in a trench coat and sunglasses",
  },
];
