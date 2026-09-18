/** Every piece of page prose that names the disease or the institute. */

import { manifest } from "./manifest.ts";

const { site, disease, institute, contact, about } = manifest;

/** Tab title, login card heading, footer. */
export const SITE_TITLE: string = site.title;
/** Navbar centre title. */
export const HEADING: string = site.heading;
export const META_DESCRIPTION: string = site.metaDescription;
export const ABOUT_TITLE: string = site.aboutTitle;
export const ABOUT_LEDE: string = site.aboutLede;
/** First sentence of the login card; the passphrase sentence is chrome. */
export const LOGIN_LEDE: string = site.loginLede;
export const PAGE_DESCRIPTIONS = site.pages;
/** Accessible name of the radar SVG. */
export const RADAR_TITLE: string =
  `${disease.adjective} clinical trials by population and phase`;
export const INSTITUTE = institute;
export const MAINTAINER = contact.maintainer;
export const ABOUT = about;
