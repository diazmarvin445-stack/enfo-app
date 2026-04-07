# ENFO — Cloud Functions (coach privado)

## Requisitos

- Proyecto Firebase en plan **Blaze** (Functions con secretos).
- Node **20** (`firebase functions` lo usará al desplegar).

## 1. Instalar dependencias

Desde la carpeta `functions/`:

```bash
cd functions
npm install
```

## 2. Secret OpenAI (no subir la clave al repo)

En la raíz del proyecto (donde está `firebase.json`):

```bash
firebase login
firebase use enfo-ee211
firebase functions:secrets:set OPENAI_API_KEY
```

Pega el valor de tu API key de OpenAI cuando lo pida. El nombre **debe ser** exactamente `OPENAI_API_KEY` (coincide con `defineSecret` en `index.js`).

## 3. Desplegar solo Functions

```bash
firebase deploy --only functions
```

La primera vez que despliegas una función que usa ese secret, Firebase vincula el secreto al runtime.

## 4. Frontend

En `index.html` la región está fijada en `ENFO_FUNCTIONS_REGION = "us-central1"`. Si cambias la región en `functions/index.js`, actualiza esa constante.

El cliente llama a la **Callable** `privateCoachChat` con el ID token del usuario; no hace falta API key en el navegador.

## 5. Probar en local (opcional)

```bash
cd functions
npm run serve
```

Para emulador con secretos, consulta la documentación de Firebase sobre `functions:secrets:access` / variables locales.
