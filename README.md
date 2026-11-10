# 🌾 La Granja VIP (Segunda Temporada) – Monitor de Votaciones en Tiempo Real

Sistema web interactivo para visualizar en **tiempo real** el estado, porcentajes exactos y conteo de votos de las votaciones activas de **La Granja VIP Segunda Temporada (TV Azteca)**.

## 🚀 Características Principales

- **Conexión en Tiempo Real (`api/live.php`):** Consulta directamente la configuración activa (`vota.json`), el estado (`vota-status.json`) y el conteo oficial de votos (`api/results?config_id=...`) de `https://vota.tvazteca.com`.
- **Soporte para Votaciones Simultáneas:** Detecta y muestra automáticamente tanto la votación principal (*Acompañante del Capataz*) como la votación secundaria (*Duelo de Nominación*).
- **Bitácora de Votos en Vivo:** Calcula y muestra los incrementos (`+votos`) entre cada actualización (configurable cada 3, 5, 10 o 30 segundos).
- **Gráficas Interactivas:** Visualización comparativa con Chart.js y tarjetas clasificadas por ranking con barras de progreso animadas.
- **Modo Híbrido (Servidor Local PHP + GitHub Pages):**
  - En servidor local (**Laragon / Apache / PHP**), `api/live.php` actúa como proxy directo sin restricciones CORS y actualiza `data/snapshot.json`.
  - En **GitHub Pages**, el frontend utiliza proxies CORS de respaldo junto con un flujo de **GitHub Actions** (`.github/workflows/update-votes.yml`) que sincroniza `data/snapshot.json` automáticamente.

## 📂 Estructura del Proyecto

```text
la_granja_vip_votaciones/
├── api/
│   └── live.php               # Endpoint proxy PHP que consulta vota.tvazteca.com en tiempo real
├── assets/
│   ├── css/
│   │   └── styles.css         # Diseño moderno Glassmorphism oscuro
│   └── js/
│       └── app.js             # Motor de actualización en tiempo real, deltas y gráficas
├── data/
│   └── snapshot.json          # Última captura oficial de votos y participantes
├── .github/
│   └── workflows/
│       └── update-votes.yml   # Automatización para actualizar datos en GitHub
├── index.html                 # Dashboard principal (compatible con GitHub Pages)
└── index.php                  # Punto de entrada para Laragon / servidores PHP
```

## 🛠️ Uso Local

1. Si usas **Laragon**, abre `http://localhost/la_granja_vip_votaciones/` en tu navegador.
2. También puedes levantar un servidor rápido desde esta carpeta con PHP:
   ```bash
   php -S localhost:8080
   ```
   Y abrir `http://localhost:8080`.
