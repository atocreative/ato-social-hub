import React from 'react';
import logoDotSvg from '../assets/brand/ato-compacto-branca-ponto-verde.svg?raw';
import logoWhiteSvg from '../assets/brand/ato-compacto-branca.svg?raw';

interface BrandLogoProps {
  /** `dot`: versão com ponto verde (marca principal). `white`: versão monocromática branca. */
  variant?: 'dot' | 'white';
  /** Altura em pixels; a largura acompanha a proporção original do logo (800×280). */
  height?: number;
  className?: string;
}

const VIEWBOX_RATIO = 800 / 280;

/**
 * Logo ATO renderizado inline (não via <img>) para que a fonte Archivo Black,
 * carregada pelo index.html, seja aplicada ao texto do SVG.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ variant = 'dot', height = 28, className = '' }) => {
  const raw = variant === 'white' ? logoWhiteSvg : logoDotSvg;
  // Remove o cabeçalho XML e deixa o SVG escalar para o tamanho do contêiner.
  const svg = raw
    .replace(/<\?xml[^>]*\?>/, '')
    .replace('width="260" height="91"', 'width="100%" height="100%" preserveAspectRatio="xMinYMid meet"');

  return (
    <span
      role="img"
      aria-label="ATO"
      className={`inline-block align-middle ${className}`}
      style={{ height, width: Math.round(height * VIEWBOX_RATIO) }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};
