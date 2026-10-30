import { DriveImageItem, TenantAccount } from '../types/index.ts';

// Helper to generate clean, professional graphic previews using ATO's real logo colors
function createSvgDataUri(width: number, height: number, title: string, subtitle: string, tag: string, accentNumber?: string): string {
  const isVertical = height > width;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#081410"/>
        <stop offset="100%" stop-color="#050C0A"/>
      </linearGradient>
      <radialGradient id="greenSoftGlow" cx="80%" cy="20%" r="60%">
        <stop offset="0%" stop-color="#25F314" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#07130F" stop-opacity="0"/>
      </radialGradient>
    </defs>
    
    <!-- Background Canvas -->
    <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
    <rect width="${width}" height="${height}" fill="url(#greenSoftGlow)"/>
    
    <!-- Clean Minimalist Frame -->
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="16" fill="none" stroke="#1A382C" stroke-width="1.5"/>
    
    <!-- Header Tag -->
    <rect x="52" y="52" width="130" height="30" rx="8" fill="#0E231B" stroke="#25F314" stroke-width="1"/>
    <text x="66" y="72" fill="#25F314" font-family="'IBM Plex Sans', sans-serif" font-size="12" font-weight="600" letter-spacing="1">ATO · ${tag}</text>

    ${accentNumber ? `
      <!-- Slide Number -->
      <circle cx="${width - 80}" cy="67" r="22" fill="#0E231B" stroke="#1A382C" stroke-width="1"/>
      <text x="${width - 80}" y="74" text-anchor="middle" fill="#25F314" font-family="'IBM Plex Mono', monospace" font-size="16" font-weight="700">${accentNumber}</text>
    ` : `
      <circle cx="${width - 70}" cy="67" r="6" fill="#25F314"/>
    `}
    
    <!-- Main Content Area -->
    <g transform="translate(52, ${isVertical ? height / 2.8 : height / 2.5})">
      <rect x="0" y="0" width="36" height="4" rx="2" fill="#25F314"/>
      <text x="0" y="46" fill="#FFFFFF" font-family="'IBM Plex Sans', sans-serif" font-size="${isVertical ? 38 : 34}" font-weight="700" letter-spacing="-0.5">
        ${title}
      </text>
      <text x="0" y="${isVertical ? 104 : 88}" fill="#C8C8C4" font-family="'IBM Plex Sans', sans-serif" font-size="${isVertical ? 20 : 17}" font-weight="400">
        ${subtitle}
      </text>
    </g>
    
    <!-- Clean Footer -->
    <line x1="52" y1="${height - 70}" x2="${width - 52}" y2="${height - 70}" stroke="#1A382C" stroke-width="1"/>
    <text x="52" y="${height - 45}" fill="#8D9E95" font-family="'IBM Plex Sans', sans-serif" font-size="12">ATO Social Midia</text>
    <text x="${width - 150}" y="${height - 45}" fill="#25F314" font-family="'IBM Plex Mono', monospace" font-size="12" font-weight="600">Instagram Hub</text>
  </svg>`;
  
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Multi-tenant accounts list starts completely empty. Tenants are registered via Instagram OAuth login.
export const initialTenants: TenantAccount[] = [];

// Empty initial media list: starts empty until real items arrive via webhook / Google Apps Script
export const initialMockDriveItems: DriveImageItem[] = [];

