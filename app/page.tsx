"use client"

import { useEffect, useRef, useState } from "react"
import io from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Pencil, Eraser, Move, Check } from "lucide-react"
import { supabase } from "@/lib/supabaseClient"

const CANVAS_WIDTH = 3000
const CANVAS_HEIGHT = 2000
const VIEWPORT_WIDTH = 800
const VIEWPORT_HEIGHT = 600
const MIN_SCALE = 0.6
const MAX_SCALE = 3.0

// Configuración para diferenciar entre pinch y pan
const PINCH_THRESHOLD = 5 // Reducido de 10 a 5 para detectar pinch más fácilmente
const PINCH_RATIO_DEADZONE = 0.04 // Aumentado de 0.025 a 0.04 para hacer zoom menos sensible
const ZOOM_DAMPING_FACTOR = 0.5 // Factor de amortiguación para hacer el zoom más gradual (entre 0 y 1)
const DRAW_DELAY = 60 // Milisegundos de retraso antes de comenzar a dibujar para detectar gestos multi-touch

type Tool = "pen" | "eraser" | "pan"

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [transform, setTransform] = useState({
    offset: { 
      x: (CANVAS_WIDTH - VIEWPORT_WIDTH) / 2, 
      y: (CANVAS_HEIGHT - VIEWPORT_HEIGHT) / 2 
    },
    scale: 1
  })
  const offset = transform.offset;
  const scale = transform.scale;
  
  const [tool, setTool] = useState<Tool>("pan")
  const [isDrawing, setIsDrawing] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const socketRef = useRef<any>(null)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const strokeBoundsRef = useRef<{minX: number, minY: number, maxX: number, maxY: number} | null>(null)
  const isDrawingMode = tool === "pen" || tool === "eraser"
  const containerRef = useRef<HTMLDivElement>(null)
  const backgroundRef = useRef<HTMLDivElement>(null)
  const touchesRef = useRef<Touch[]>([])
  const lastPinchDistanceRef = useRef<number | null>(null)
  const lastTouchCenterRef = useRef<{x: number, y: number} | null>(null)
  const initialGestureRef = useRef<'unknown' | 'zoom' | 'pan'>('unknown')
  const recentZoomFactorsRef = useRef<number[]>([])
  const pinchStartScaleRef = useRef<number>(1);

  // Nuevas referencias para mejorar la detección de gestos
  const gestureIntentRef = useRef<'pinch' | 'pan' | null>(null);
  const initialPinchDistanceRef = useRef<number | null>(null);

  // Referencia para el timeout de dibujo
  const drawTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Estado para indicar si el dibujo está pendiente (esperando el timeout)
  const pendingDrawRef = useRef<{x: number, y: number} | null>(null);
  // Nueva referencia para rastrear si el último gesto fue multi-táctil
  const lastWasMultiTouchRef = useRef(false);

  // Estado para el panel de depuración
  const [debugData, setDebugData] = useState<{
    eventType: string;
    timestamp: number;
    touchCount: number;
    isDrawing: boolean;
    isDrawingMode: boolean;
    lastWasMultiTouch: boolean;
    hasTimeout: boolean;
    lastPoint: { x: number, y: number } | null;
    pendingDraw: { x: number, y: number } | null;
    gestureIntent: string | null;
    touchPositions: { id: number, x: number, y: number }[];
    eventHistory: { type: string, touchCount: number, time: number }[];
    wasMultiTouchBefore: boolean;
    previousTouchCount: number | null;
    convertedPosition: { x: number, y: number } | null;
    // Nuevos campos para depuración avanzada
    strokeHistory: { 
      from: { x: number, y: number }, 
      to: { x: number, y: number },
      distance: number,
      time: number,
      isSuspicious: boolean,
      timeDelta: number
    }[];
    sessionId: number; // ID único para cada sesión de toque
    drawCallCount: number; // Contador de llamadas a drawLine
    lastResetReason: string; // Razón del último reinicio de pendingDraw
    lastFrameDelta: number; // Delta entre el último frame y el actual
  }>({
    eventType: "init",
    timestamp: Date.now(),
    touchCount: 0,
    isDrawing: false,
    isDrawingMode: false,
    lastWasMultiTouch: false,
    hasTimeout: false,
    lastPoint: null,
    pendingDraw: null,
    gestureIntent: null,
    touchPositions: [],
    eventHistory: [],
    wasMultiTouchBefore: false,
    previousTouchCount: null,
    convertedPosition: null,
    // Inicializar nuevos campos
    strokeHistory: [],
    sessionId: 0,
    drawCallCount: 0,
    lastResetReason: "init",
    lastFrameDelta: 0
  });
  
  // Estado para mostrar/ocultar el panel de depuración
  const [showDebugPanel, setShowDebugPanel] = useState(true);
  
  // Historial de eventos para depuración
  const eventHistoryRef = useRef<{ type: string, touchCount: number, time: number }[]>([]);
  const MAX_EVENT_HISTORY = 10; // Reducido a 10 eventos para ser más conciso
  const lastMultiTouchEventRef = useRef<number>(0); // Timestamp del último evento multi-touch
  const debuggingActiveRef = useRef<boolean>(false); // Indica si el registro de depuración está activo
  const sessionIdRef = useRef<number>(0); // ID de la sesión actual (incrementa cada touchstart)
  const strokeHistoryRef = useRef<any[]>([]); // Historial de trazos para depuración
  const MAX_STROKE_HISTORY = 20; // Máximo número de trazos a guardar
  const lastDrawCallTimeRef = useRef<number>(0); // Tiempo de la última llamada a drawLine
  const lastResetReasonRef = useRef<string>("init"); // Razón del último reinicio de pendingDraw
  
  // Referencia para guardar la cuenta de toques previa
  const previousTouchCountRef = useRef<number>(0);
  
  // Añadir una nueva referencia para rastrear el primer movimiento de una nueva sesión
  const isFirstMoveAfterTouchRef = useRef<boolean>(false);
  const lastSessionIdRef = useRef<number>(0);

  // Añadir una nueva referencia para el período de gracia
  const initialGestureTimeRef = useRef<number>(0);
  const GESTURE_GRACE_PERIOD = 150; // ms para determinar la intención del gesto

  // Añadir una nueva referencia para el punto inicial del pinch
  const initialPinchCenterRef = useRef<{x: number, y: number} | null>(null);
  const isNewMultiTouchRef = useRef<boolean>(false);

  // Añadir nuevas referencias para rastrear mejor los movimientos rápidos
  const lastMoveTimestampRef = useRef<number>(0);
  const consecutiveZoomMovesRef = useRef<number>(0);

  // Función para actualizar los datos de depuración
  const updateDebugData = (eventType: string) => {
    // Solo registrar si estamos en modo dibujo o si ya estamos registrando activamente
    if (tool === "pan" && !debuggingActiveRef.current) {
      return;
    }
    
    // Activar el registro de depuración cuando entramos en modo dibujo
    if (tool !== "pan") {
      debuggingActiveRef.current = true;
    }
    
    const currentTime = Date.now();
    const touchCount = touchesRef.current.length;
    
    // Calcular delta de tiempo
    const lastFrameDelta = lastDrawCallTimeRef.current ? currentTime - lastDrawCallTimeRef.current : 0;
    
    // Actualizar historial de eventos
    const newEvent = { 
      type: eventType, 
      touchCount,
      time: currentTime 
    };
    
    const updatedHistory = [...eventHistoryRef.current, newEvent].slice(-MAX_EVENT_HISTORY);
    eventHistoryRef.current = updatedHistory;
    
    // Calcular la posición convertida si hay un touch disponible
    let convertedPosition = null;
    if (touchCount > 0 && touchesRef.current[0]) {
      const touch = touchesRef.current[0];
      convertedPosition = getCanvasCoordinates(touch.clientX, touch.clientY);
    }
    
    // Actualizar datos de depuración
    setDebugData({
      eventType,
      timestamp: currentTime,
      touchCount,
      isDrawing,
      isDrawingMode: tool !== "pan",
      lastWasMultiTouch: lastWasMultiTouchRef.current,
      hasTimeout: drawTimeoutRef.current !== null,
      lastPoint: lastPoint.current,
      pendingDraw: pendingDrawRef.current,
      gestureIntent: gestureIntentRef.current,
      touchPositions: touchesRef.current.map(touch => ({
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY
      })),
      eventHistory: updatedHistory,
      wasMultiTouchBefore: previousTouchCountRef.current >= 2,
      previousTouchCount: previousTouchCountRef.current,
      convertedPosition,
      // Nuevos campos
      strokeHistory: strokeHistoryRef.current,
      sessionId: sessionIdRef.current,
      drawCallCount: strokeHistoryRef.current.length,
      lastResetReason: lastResetReasonRef.current,
      lastFrameDelta: lastFrameDelta
    });
  };
  
  // Función para copiar los datos de depuración al portapapeles
  const copyDebugData = () => {
    const debugString = JSON.stringify(debugData, null, 2);
    
    try {
      // Método 1: Usar la API Clipboard si está disponible
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(debugString)
          .then(() => {
            alert("Datos copiados al portapapeles");
          })
          .catch(err => {
            console.error("Error al copiar con Clipboard API: ", err);
            // Si falla, intentar el método alternativo
            fallbackCopy();
          });
      } else {
        // Método 2: Fallback para navegadores que no soportan Clipboard API
        fallbackCopy();
      }
    } catch (err) {
      console.error("Error al copiar datos: ", err);
      // Método 3: Último recurso - mostrar los datos para copiar manualmente
      alert("No se pudo copiar automáticamente. Aquí están los datos para copiar manualmente:\n\n" + debugString);
    }
    
    // Función de respaldo para copiar usando el método de elemento temporal
    function fallbackCopy() {
      // Crear un elemento textarea temporal
      const textArea = document.createElement("textarea");
      textArea.value = debugString;
      
      // Hacer que el textarea no sea visible
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      
      // Preservar la posición de desplazamiento
      const scrollPos = window.pageYOffset || document.documentElement.scrollTop;
      
      // Seleccionar y copiar el texto
      textArea.focus();
      textArea.select();
      
      let success = false;
      try {
        success = document.execCommand("copy");
        if (success) {
          alert("Datos copiados al portapapeles");
        } else {
          alert("No se pudo copiar automáticamente. Por favor, intenta copiar manualmente.");
        }
      } catch (err) {
        console.error("Error al ejecutar comando de copia: ", err);
        alert("No se pudo copiar automáticamente. Por favor, intenta copiar manualmente.");
      }
      
      // Limpiar
      document.body.removeChild(textArea);
      
      // Restaurar la posición de desplazamiento
      window.scrollTo(0, scrollPos);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Set canvas size
    canvas.width = CANVAS_WIDTH
    canvas.height = CANVAS_HEIGHT

    // Connect to WebSocket server
    socketRef.current = io()

    // Load initial canvas state from Supabase
    const loadCanvasState = async () => {
      try {
        console.log('Fetching initial state from Supabase...')
        const { data, error } = await supabase
          .from('canvas_states')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)

        if (error) {
          throw error
        }

        if (data && data.length > 0) {
          console.log('Found saved state, loading...')
          const img = new Image()
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0)
          }
          img.src = data[0].state
        }
      } catch (error) {
        console.error('Error loading initial state:', error)
      }
    }

    loadCanvasState()

    // Solicitar el estado actual del canvas al conectarse
    socketRef.current.emit('requestCanvasState')

    // Escuchar el estado inicial del canvas
    socketRef.current.on('canvasState', (imageData: string) => {
      if (!imageData) return
      console.log('Received canvas state')
      
      const img = new Image()
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height) // Limpiar el canvas primero
        ctx.drawImage(img, 0, 0)
      }
      img.src = imageData
    })

    socketRef.current.on(
      "draw",
      (data: {
        fromX: number
        fromY: number
        toX: number
        toY: number
        tool: Tool
      }) => {
        drawLine(ctx, data.fromX, data.fromY, data.toX, data.toY, data.tool)
      },
    )

    return () => {
      socketRef.current.disconnect()
    }
  }, [])

  useEffect(() => {
    const handlePointerUpDocument = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('#controls')) return;
      setIsPanning(false);
      setIsDrawing(false);
      lastPoint.current = null;
    };
    document.addEventListener("pointerup", handlePointerUpDocument);
    return () => {
      document.removeEventListener("pointerup", handlePointerUpDocument);
    };
  }, []);

  // Add touch event handlers for multi-touch gestures
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      
      // Incrementar el ID de sesión para cada nuevo toque
      sessionIdRef.current++;
      
      // Marcar este toque como el primero de una nueva sesión
      isFirstMoveAfterTouchRef.current = true;
      
      // Reiniciar la intención del gesto al inicio de un nuevo toque
      gestureIntentRef.current = null;
      initialGestureTimeRef.current = Date.now();
      
      // Capturar los toques actuales
      const touches = Array.from(e.touches);
      touchesRef.current = touches;
      
      // SIEMPRE limpiar cualquier punto pendiente y último punto al inicio de una nueva sesión
      pendingDrawRef.current = null;
      lastPoint.current = null;
      lastResetReasonRef.current = "touchstart_new_session";
      
      // Si tenemos una sesión completamente nueva (después de haber levantado todos los dedos)
      if (lastSessionIdRef.current !== sessionIdRef.current) {
        lastSessionIdRef.current = sessionIdRef.current;
        
        // Forzar limpieza adicional para asegurar que no haya persistencia entre sesiones
        pendingDrawRef.current = null;
        lastPoint.current = null;
        
        // Registrar este cambio de sesión para depuración
        updateDebugData("new_touch_session");
      }
      
      // Si tenemos un solo dedo y estamos en modo dibujo
      if (e.touches.length === 1 && isDrawingMode) {
        const touch = e.touches[0];
        const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        
        // Limpiar cualquier timeout previo
        if (drawTimeoutRef.current) {
          clearTimeout(drawTimeoutRef.current);
          drawTimeoutRef.current = null;
        }
        
        // SIEMPRE comenzar con un lastPoint limpio
        lastPoint.current = null;
        
        // Ahora que hemos limpiado pendingDraw al inicio, lo configuramos con la nueva posición
        pendingDrawRef.current = { x, y };
        
        // Si el último gesto fue multi-táctil o paneo, necesitamos más tiempo 
        // para confirmar que realmente queremos dibujar
        if (lastWasMultiTouchRef.current || gestureIntentRef.current === "pan") {
          // No iniciar el dibujo de inmediato, esperar para confirmar la intención
          setIsDrawing(false);
          
          // Establecer un temporizador para confirmar que es un gesto de dibujo
          drawTimeoutRef.current = setTimeout(() => {
            // Solo dibujar si aún tenemos un solo dedo y estamos en modo dibujo
            if (touchesRef.current.length === 1 && pendingDrawRef.current && isDrawingMode) {
              // Iniciar el dibujo desde el punto pendiente
              lastPoint.current = { ...pendingDrawRef.current };
        setIsDrawing(true);
              
              // Establecer los límites iniciales del trazo para el lápiz
        if (tool === "pen") {
                strokeBoundsRef.current = { 
                  minX: pendingDrawRef.current.x, 
                  minY: pendingDrawRef.current.y, 
                  maxX: pendingDrawRef.current.x, 
                  maxY: pendingDrawRef.current.y 
                };
              }
              
              // Ya no estamos en un gesto multi-táctil
              lastWasMultiTouchRef.current = false;
              // Reiniciar la intención de gesto
              gestureIntentRef.current = null;
            }
            drawTimeoutRef.current = null;
          }, DRAW_DELAY);
        } 
        // Si no venimos de multi-táctil ni paneo, podemos iniciar el dibujo más rápido
        else {
          drawTimeoutRef.current = setTimeout(() => {
            if (touchesRef.current.length === 1 && pendingDrawRef.current && isDrawingMode) {
              lastPoint.current = { ...pendingDrawRef.current };
              setIsDrawing(true);
              if (tool === "pen") {
                strokeBoundsRef.current = { 
                  minX: pendingDrawRef.current.x, 
                  minY: pendingDrawRef.current.y, 
                  maxX: pendingDrawRef.current.x, 
                  maxY: pendingDrawRef.current.y 
                };
              }
            }
            drawTimeoutRef.current = null;
          }, DRAW_DELAY);
        }
      }
      // Si tenemos un solo dedo y estamos en modo paneo
      else if (e.touches.length === 1 && !isDrawingMode) {
        // Establecer el punto inicial para el paneo
        const touch = e.touches[0];
        lastTouchCenterRef.current = {
          x: touch.clientX,
          y: touch.clientY
        };
        
        // Reiniciar la intención de gesto
        gestureIntentRef.current = "pan";
        
        // Reiniciar otros estados
        lastPoint.current = null;
        lastWasMultiTouchRef.current = false;
      }
      // Si tenemos múltiples dedos, establecer el modo multi-táctil
      else if (e.touches.length >= 2) {
        // Si tenemos un timeout de dibujo, eliminarlo
        if (drawTimeoutRef.current !== null) {
          clearTimeout(drawTimeoutRef.current);
          drawTimeoutRef.current = null;
        }
        
        // Marcar que el último gesto fue multi-touch
        lastWasMultiTouchRef.current = true;
        setIsDrawing(false);
        lastPoint.current = null;
        
        // Calcular el centro de los dos primeros toques
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const centerX = (touch1.clientX + touch2.clientX) / 2;
        const centerY = (touch1.clientY + touch2.clientY) / 2;
        
        // Marcar que este es un nuevo gesto multi-touch
        isNewMultiTouchRef.current = true;
        
        // Guardar el centro inicial del pinch para el zoom centrado
        initialPinchCenterRef.current = { x: centerX, y: centerY };
        
        // Establecer el centro actual para referencias futuras
        lastTouchCenterRef.current = { x: centerX, y: centerY };
        
        // Calcular y guardar la distancia inicial entre dedos
        lastPinchDistanceRef.current = getPinchDistance(touch1, touch2);
        
        // Registrar el tiempo de inicio del gesto
        initialGestureTimeRef.current = Date.now();
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();

      // Obtener los toques actuales
      const touches = Array.from(e.touches);
      touchesRef.current = touches;
      
      // Registrar la timestamp actual para cálculos de velocidad
      const currentTimestamp = Date.now();
      const timeSinceLastMove = currentTimestamp - lastMoveTimestampRef.current;
      lastMoveTimestampRef.current = currentTimestamp;
      
      // Actualizar datos de depuración
      updateDebugData("touchmove");
      
      // Si es el primer movimiento después de un touchstart, no dibujar
      // Esto previene líneas desde un punto anterior a uno nuevo
      if (isFirstMoveAfterTouchRef.current && tool === "pen") {
        // Obtener la posición actual para usarla como punto de inicio para futuros movimientos
        if (touches.length === 1) {
          const touch = touches[0];
          const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        
          // Establecer este punto como el punto inicial para futuros movimientos
          pendingDrawRef.current = { x, y };
          lastPoint.current = { x, y };
          
          // Registrar este cambio
          updateDebugData("first_move_no_draw");
        }
        
        // Ya no es el primer movimiento
        isFirstMoveAfterTouchRef.current = false;
        return; // Importante: salir sin dibujar nada
      }
      
      // Reiniciar la bandera de primer movimiento
      isFirstMoveAfterTouchRef.current = false;
      
      // Para panning y zooming (multi-touch)
      if (touches.length >= 2) {
        // Si tenemos un timeout de dibujo, eliminarlo
        if (drawTimeoutRef.current !== null) {
          window.clearTimeout(drawTimeoutRef.current);
          drawTimeoutRef.current = null;
        }
        
        // Marcar que el último gesto fue multi-touch
        lastWasMultiTouchRef.current = true;
        
        // Calcular el centro de los dos primeros toques
        const touch1 = touches[0];
        const touch2 = touches[1];
        const centerX = (touch1.clientX + touch2.clientX) / 2;
        const centerY = (touch1.clientY + touch2.clientY) / 2;
        
        // Si este es el primer movimiento multi-touch o no tenemos centro previo
        if (!lastTouchCenterRef.current) {
          lastTouchCenterRef.current = { x: centerX, y: centerY };
          lastPinchDistanceRef.current = getPinchDistance(touch1, touch2);
          initialGestureTimeRef.current = Date.now();
          return;
        }
        
        // Calcular la distancia de pinza actual
        const currentPinchDistance = getPinchDistance(touch1, touch2);
        
        // Si no tenemos distancia previa, solo guardar la actual
        if (!lastPinchDistanceRef.current) {
          lastPinchDistanceRef.current = currentPinchDistance;
          return;
        }
        
        // Calcular la diferencia desde el último centro
        const deltaX = centerX - lastTouchCenterRef.current.x;
        const deltaY = centerY - lastTouchCenterRef.current.y;
        
        // Ver si hubo cambio en la distancia (zoom)
        const pinchDelta = currentPinchDistance / lastPinchDistanceRef.current;
        const isPinching = Math.abs(pinchDelta - 1) > PINCH_RATIO_DEADZONE;
        
        // Calcular si hay movimiento significativo para paneo
        const hasPanMovement = Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5;
        
        // Determinar la intención del gesto durante el período de gracia
        const isInGracePeriod = Date.now() - initialGestureTimeRef.current < GESTURE_GRACE_PERIOD;
        
        // Si es un nuevo gesto multi-touch, ignorar el primer movimiento para evitar saltos
        if (isNewMultiTouchRef.current) {
          isNewMultiTouchRef.current = false;
          lastTouchCenterRef.current = { x: centerX, y: centerY };
          lastPinchDistanceRef.current = currentPinchDistance;
          
          // Actualizar el centro inicial del pinch para el zoom centrado
          initialPinchCenterRef.current = { x: centerX, y: centerY };
          return;
        }
        
        // Manejar detección de intención del gesto
        if (gestureIntentRef.current === null) {
          if (isPinching) {
            // Si hay pinch claro, es zoom
            gestureIntentRef.current = "pinch";
            // Actualizar el centro inicial del pinch para el zoom centrado
            initialPinchCenterRef.current = { x: centerX, y: centerY };
            // Iniciar contador de movimientos consecutivos de zoom
            consecutiveZoomMovesRef.current = 1;
          } else if (hasPanMovement) {
            // Si hay movimiento claro sin pinch, es paneo
            gestureIntentRef.current = "pan";
            // Resetear contador de movimientos de zoom
            consecutiveZoomMovesRef.current = 0;
          }
        } 
        // Si ya tenemos una intención, pero hay un cambio claro en el movimiento
        else if (isPinching && gestureIntentRef.current === "pan") {
          // Cambio de paneo a zoom - este es el caso problemático
          gestureIntentRef.current = "pinch";
          // Actualizar inmediatamente el centro para el zoom
          initialPinchCenterRef.current = { x: centerX, y: centerY };
          consecutiveZoomMovesRef.current = 1;
        } else if (hasPanMovement && !isPinching && gestureIntentRef.current === "pinch") {
          // Cambio de zoom a paneo
          gestureIntentRef.current = "pan";
          consecutiveZoomMovesRef.current = 0;
        }
        
        // Si estamos haciendo zoom, incrementar el contador de movimientos consecutivos
        if (gestureIntentRef.current === "pinch" && isPinching) {
          consecutiveZoomMovesRef.current++;
        }
        
        // Actualizar el centro para próxima iteración (siempre)
        lastTouchCenterRef.current = { x: centerX, y: centerY };
        
        // Ejecutar la acción basada en la intención del gesto
        if (gestureIntentRef.current === "pinch") {
          // Aplicar zoom centrado en la posición actual
          // Usamos el centro actual para todos los cálculos, sin depender de valores anteriores
          applyZoomAtPoint(pinchDelta, { x: centerX, y: centerY });
          
          // Actualizar última distancia para próxima iteración
          lastPinchDistanceRef.current = currentPinchDistance;
          
          // También aplicar paneo simultáneo al zoom, SOLO si hay un desplazamiento significativo
          if (hasPanMovement && consecutiveZoomMovesRef.current > 2) {
            // Aplicar un factor de amortiguación para suavizar el paneo durante el zoom
            const panFactor = 0.5; // Reduce a la mitad la velocidad de paneo durante zoom
            applyPanWithConstraints(deltaX * panFactor, deltaY * panFactor);
          }
        } 
        // Si la intención es paneo o aún no está determinada pero hay movimiento
        else {
          // Aplicar el paneo con límites mejorados
          applyPanWithConstraints(deltaX, deltaY);
          
          // Actualizar la distancia de pinch para el próximo frame
          // (importante para mantener una referencia actualizada)
          lastPinchDistanceRef.current = currentPinchDistance;
        }
        
        // Borrar cualquier pendingDraw para evitar líneas erróneas
        pendingDrawRef.current = null;
        lastPoint.current = null;
        lastResetReasonRef.current = gestureIntentRef.current === "pinch" ? "zoom_gesture" : "pan_gesture";
      }
      // Para dibujo con un solo dedo
      else if (touches.length === 1) {
        const touch = touches[0];
        
        // En modo pan, manejar paneo con un solo dedo
        if (tool === "pan") {
          // Si este es el primer movimiento
          if (!lastTouchCenterRef.current) {
            lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
            gestureIntentRef.current = "pan";
            return;
          }
          
          // Calcular la diferencia
          const deltaX = touch.clientX - lastTouchCenterRef.current.x;
          const deltaY = touch.clientY - lastTouchCenterRef.current.y;
          
          // Actualizar el centro
          lastTouchCenterRef.current = { x: touch.clientX, y: touch.clientY };
          
          // Si hay suficiente movimiento, hacer paneo
          if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
            // Usar la función mejorada para aplicar el paneo con límites
            applyPanWithConstraints(deltaX, deltaY);
          }
        }
        // En modo de dibujo, procesar el movimiento para dibujar
        else if ((tool === "pen" || tool === "eraser") && !drawTimeoutRef.current) {
          // Obtener las coordenadas del canvas
          const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
          
          // SEGURIDAD ADICIONAL: Si pendingDraw es null, no dibujar y establecerlo
          if (!pendingDrawRef.current) {
            pendingDrawRef.current = { x, y };
            lastPoint.current = { x, y };
            updateDebugData("restore_pending_draw");
            return; // Salir sin dibujar
          }
          
          // Obtener el contexto de dibujo
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          
          // SEGURIDAD: Verificar distancia para evitar líneas muy largas
          const distance = Math.sqrt(
            Math.pow(x - pendingDrawRef.current.x, 2) + 
            Math.pow(y - pendingDrawRef.current.y, 2)
          );
          
          // Si la distancia es sospechosamente grande, no dibujar
          if (distance > 100) {
            // Registrar este evento sospechoso
            const suspiciousStroke = {
              from: pendingDrawRef.current,
              to: { x, y },
              distance: distance,
              time: Date.now(),
              isSuspicious: true,
              timeDelta: Date.now() - lastDrawCallTimeRef.current
            };
            strokeHistoryRef.current = [...strokeHistoryRef.current, suspiciousStroke].slice(-MAX_STROKE_HISTORY);
            
            // Actualizar el punto pendiente sin dibujar
            pendingDrawRef.current = { x, y };
            lastPoint.current = { x, y };
            
            updateDebugData("skipped_suspicious_line");
            return; // Salir sin dibujar
          }
          
          // Dibujar la línea
          drawLine(ctx, pendingDrawRef.current.x, pendingDrawRef.current.y, x, y, tool);
          
          // Actualizar el punto pendiente para el siguiente movimiento
          pendingDrawRef.current = { x, y };
          lastPoint.current = { x, y };
          
          // Si no estábamos dibujando antes, ahora sí
          if (!isDrawing) {
            setIsDrawing(true);
          }
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      
      // Registrar eventos con conteos de toques y la intención del gesto
      updateDebugData(`touchend (${gestureIntentRef.current || "none"})`);
      
      // Capturar la lista actual de toques activos
      const currentTouches = Array.from(e.touches);
      
      // Actualizar referencias
      touchesRef.current = currentTouches;
      previousTouchCountRef.current = currentTouches.length;
      
      // Si ya no hay dedos en la pantalla, SIEMPRE hay que limpiar pendingDraw
      // Este es un cambio crítico para evitar las líneas rectas
      if (currentTouches.length === 0) {
        pendingDrawRef.current = null;
        lastResetReasonRef.current = "touchend_all_fingers_up";
        updateDebugData("reset_at_touchend");
        
        // También restablecer el último punto para mayor seguridad
        lastPoint.current = null;
        
        // Y detener el dibujo
        setIsDrawing(false);
        return;
      }
      
      // Verificar si el último gesto fue multitouch
      if (lastWasMultiTouchRef.current) {
        // Si el gesto anterior fue multitouch y ahora es un toque único,
        // necesitamos reiniciar el punto pendiente para evitar líneas no deseadas
        if (currentTouches.length === 1) {
          pendingDrawRef.current = null;
          lastResetReasonRef.current = "touchend_from_multitouch";
          updateDebugData("reset_after_multitouch");
          
          // También restablecer el último punto
        lastPoint.current = null;
        }
      }
      
      // Si estamos en modo dibujo y tenemos un solo toque, podemos seguir dibujando
      if (tool !== "pan" && currentTouches.length === 1) {
        // Continuar dibujando
      }
      
      // Si estábamos paneando en modo dibujo y ahora queremos dibujar
      if (previousTouchCountRef.current === 1 && currentTouches.length === 1 && 
          isDrawingMode && gestureIntentRef.current === "pan") {
        // Resetear el estado para comenzar un nuevo trazo
        lastPoint.current = null;
        
        // Asegurarnos de que pendingDraw tenga la posición actual
        const touch = e.touches[0];
        const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        pendingDrawRef.current = { x, y };
        
        // Iniciar nueva secuencia de dibujo con temporizador
        drawTimeoutRef.current = setTimeout(() => {
          if (touchesRef.current.length === 1 && pendingDrawRef.current && isDrawingMode) {
            lastPoint.current = { ...pendingDrawRef.current };
            setIsDrawing(true);
            if (tool === "pen") {
              strokeBoundsRef.current = { 
                minX: pendingDrawRef.current.x, 
                minY: pendingDrawRef.current.y, 
                maxX: pendingDrawRef.current.x, 
                maxY: pendingDrawRef.current.y 
              };
            }
            // Resetear la intención de gesto
            gestureIntentRef.current = null;
          }
          drawTimeoutRef.current = null;
        }, DRAW_DELAY);
      }
      // Si era multi-touch y ahora es single-touch (o ninguno) en modo dibujo
      else if (previousTouchCountRef.current >= 2 && currentTouches.length <= 1 && isDrawingMode) {
        // Reiniciar estado para evitar líneas rectas no deseadas
        lastPoint.current = null;
        lastWasMultiTouchRef.current = true; // Marcar que venimos de un gesto multi-touch
        setIsDrawing(false);
        
        // Si queda un dedo y estamos en modo dibujo, preparar nuevo punto de inicio
        if (currentTouches.length === 1) {
          const touch = e.touches[0];
          const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
          
          // Configurar nuevo punto pendiente en la posición actual del dedo
          pendingDrawRef.current = { x, y };
          
          // Iniciar temporizador para confirmar que es un gesto de dibujo
          drawTimeoutRef.current = setTimeout(() => {
            if (touchesRef.current.length === 1 && pendingDrawRef.current && isDrawingMode) {
              lastPoint.current = { ...pendingDrawRef.current };
              setIsDrawing(true);
              if (tool === "pen") {
                strokeBoundsRef.current = { 
                  minX: pendingDrawRef.current.x, 
                  minY: pendingDrawRef.current.y, 
                  maxX: pendingDrawRef.current.x, 
                  maxY: pendingDrawRef.current.y 
                };
              }
              lastWasMultiTouchRef.current = false;
              // También resetear la intención de gesto
              gestureIntentRef.current = null;
            }
            drawTimeoutRef.current = null;
          }, DRAW_DELAY);
        } else {
          // Si no quedan dedos, asegurarse de resetear pendingDraw
          pendingDrawRef.current = null;
        }
      } 
      // Si terminamos un trazo normal (un solo dedo)
      else if (previousTouchCountRef.current === 1 && currentTouches.length === 0 && isDrawing) {
        setIsDrawing(false);
        
        // IMPORTANTE: Resetear pendingDraw al terminar un trazo
        pendingDrawRef.current = null;
        
        // Si estábamos dibujando y era un trazo válido, guardar el estado del canvas
        if (strokeBoundsRef.current && tool === "pen") {
          saveCanvasState();
          strokeBoundsRef.current = null;
        }
      } 
      // Nuevo caso: Manejo del paneo con un dedo en modo paneo
      else if (previousTouchCountRef.current === 1 && currentTouches.length === 0 && !isDrawingMode) {
        // Resetear las referencias de paneo cuando se termina el paneo
        lastTouchCenterRef.current = null;
        gestureIntentRef.current = null;
      }
      // Nuevo caso: Transición de multi-touch a un dedo en modo paneo
      else if (previousTouchCountRef.current >= 2 && currentTouches.length === 1 && !isDrawingMode) {
        // Configurar para paneo con el dedo restante
            const touch = e.touches[0];
            lastTouchCenterRef.current = {
              x: touch.clientX,
              y: touch.clientY
            };
        // Cambiar intención a paneo
        gestureIntentRef.current = "pan";
      }
      // Si no quedan dedos en la pantalla, resetear todo
      else if (currentTouches.length === 0) {
        setIsDrawing(false);
        setIsPanning(false);
        // También resetear las variables de referencia para mayor seguridad
        lastPoint.current = null;
        pendingDrawRef.current = null; // Asegurar una vez más que esto está limpio
        gestureIntentRef.current = null;
        // Resetear las referencias de pinch/zoom
        lastPinchDistanceRef.current = null;
        initialPinchDistanceRef.current = null;
            lastTouchCenterRef.current = null;
      }
    };

    // Helper function to calculate distance between two touch points
    const getPinchDistance = (touch1: Touch, touch2: Touch) => {
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    // Add event listeners
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('touchcancel', handleTouchEnd);

    // Cleanup
    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isDrawingMode, tool, isDrawing, transform.scale]);

  // Add mouse wheel event handler for zooming
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Al inicio, calculamos las dimensiones base del viewport
    const baseViewportWidth = window.innerWidth;
    const baseViewportHeight = window.innerHeight;
    
    // Calculamos la escala mínima base una sola vez
    const baseMinScale = Math.max(
      baseViewportWidth / CANVAS_WIDTH,
      baseViewportHeight / CANVAS_HEIGHT
    );

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      
      // Determine zoom direction - normalize across browsers
      const zoomIn = e.deltaY < 0;
      
      // Get viewport info (current)
      const rect = canvas.getBoundingClientRect();
      
      // Get mouse position relative to canvas
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // Current scale and zoom factors
      const currentScale = transform.scale;
      const zoomInFactor = 1.1;
      const zoomOutFactor = 0.9;
      
      // Calculate new scale based on direction
      let newScale;
      if (zoomIn) {
        // For zoom in: multiply by factor but cap at MAX_SCALE
        newScale = Math.min(currentScale * zoomInFactor, MAX_SCALE);
      } else {
        // For zoom out: multiply by factor but floor at MIN_SCALE
        newScale = Math.max(currentScale * zoomOutFactor, MIN_SCALE);
      }
      
      // Only proceed if scale would change significantly
      if (Math.abs(newScale - currentScale) > 0.001) {
        // Calculate scale factor between old and new scales
        const scaleFactor = newScale / currentScale;
        
        // Get viewport dimensions
        const viewportWidth = rect.width;
        const viewportHeight = rect.height;
        
        // Actualizar el estado transform de forma atómica
        setTransform(prev => {
          // Calculate new offsets to zoom toward/from mouse position
          // Esto mantiene el punto bajo el cursor en la misma posición relativa durante el zoom
          let newOffsetX = mouseX - (mouseX - prev.offset.x) * scaleFactor;
          let newOffsetY = mouseY - (mouseY - prev.offset.y) * scaleFactor;
          
          // Calcular los límites máximos para asegurar que el canvas cubra todo el viewport
          const maxOffsetX = Math.max(0, CANVAS_WIDTH * newScale - viewportWidth);
          const maxOffsetY = Math.max(0, CANVAS_HEIGHT * newScale - viewportHeight);
          
          // Aplicar las restricciones para evitar ver espacios en blanco
          newOffsetX = Math.max(0, Math.min(maxOffsetX, newOffsetX));
          newOffsetY = Math.max(0, Math.min(maxOffsetY, newOffsetY));
          
          // Return new state object with both scale and offset updated atomically
          return {
            scale: newScale,
            offset: {
              x: newOffsetX,
              y: newOffsetY
            }
          };
        });
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Completely rewritten direct zoom function for debugging
  const forceZoom = (zoomIn: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Get viewport info
    const rect = canvas.getBoundingClientRect();
    const viewportWidth = rect.width;
    const viewportHeight = rect.height;
    
    // Center point for zooming
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight / 2;
    
    // Actualizar de forma atómica usando setTransform
    setTransform(prev => {
      // Current scale and zoom factors
      const currentScale = prev.scale;
      const zoomInFactor = 1.1;
      const zoomOutFactor = 0.9;
      
      // Calculate new scale based on direction
      let newScale;
      if (zoomIn) {
        // For zoom in: multiply by factor but cap at MAX_SCALE
        newScale = Math.min(currentScale * zoomInFactor, MAX_SCALE);
      } else {
        // For zoom out: multiply by factor but floor at MIN_SCALE
        newScale = Math.max(currentScale * zoomOutFactor, MIN_SCALE);
      }
      
      // Only proceed if scale would change
      if (Math.abs(newScale - currentScale) > 0.001) {
        // Calculate new offsets, zooming towards center
        let newOffsetX = centerX - (centerX - prev.offset.x) * (newScale / currentScale);
        let newOffsetY = centerY - (centerY - prev.offset.y) * (newScale / currentScale);
        
        // Calculate maximum valid offsets based on new scale
        const maxOffsetX = Math.max(0, CANVAS_WIDTH * newScale - viewportWidth);
        const maxOffsetY = Math.max(0, CANVAS_HEIGHT * newScale - viewportHeight);
        
        // Constrain offsets to valid range
        newOffsetX = Math.max(0, Math.min(maxOffsetX, newOffsetX));
        newOffsetY = Math.max(0, Math.min(maxOffsetY, newOffsetY));
        
        // Return updated state
        return {
          scale: newScale,
          offset: {
            x: newOffsetX,
            y: newOffsetY
          }
        };
      }
      
      // If no significant change, return unchanged state
      return prev;
    });
  };

  // Actualizar manejo de dimensiones cuando cambia el tamaño de la ventana
  useEffect(() => {
    const handleResize = () => {
      if (!canvasRef.current) return;
      
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Calculamos pero NO usamos para limitar el zoom out
      const calculatedMinScale = Math.max(
        viewportWidth / CANVAS_WIDTH,
        viewportHeight / CANVAS_HEIGHT
      );
      
      console.log("Window resize - dimensions:", {
        currentScale: transform.scale,
        calculatedMinScale,
        actualMinScale: MIN_SCALE,
        viewportWidth,
        viewportHeight
      });
      
      // Actualizamos los offsets para asegurar que siguen siendo válidos
      setTransform(prev => {
        const maxOffsetX = Math.max(0, CANVAS_WIDTH * prev.scale - viewportWidth);
        const maxOffsetY = Math.max(0, CANVAS_HEIGHT * prev.scale - viewportHeight);
        
        return {
          ...prev,
          offset: {
            x: Math.max(0, Math.min(maxOffsetX, prev.offset.x)),
            y: Math.max(0, Math.min(maxOffsetY, prev.offset.y))
          }
        };
      });
    };
    
    window.addEventListener('resize', handleResize);
    
    // Initial check
    handleResize();
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [transform.scale]);

  const getCanvasCoordinates = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }

    // Obtenemos el rectángulo del elemento canvas en el viewport
    const rect = canvas.getBoundingClientRect()
    
    // Obtenemos la posición del elemento que contiene el canvas (el div con el fondo)
    const backgroundRect = backgroundRef.current?.getBoundingClientRect()
    
    // Información de diagnóstico
    console.log("Canvas transform details:", {
      clientCoords: { x: clientX, y: clientY },
      canvasRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      backgroundRect: backgroundRect ? { 
        left: backgroundRect.left, 
        top: backgroundRect.top, 
        width: backgroundRect.width, 
        height: backgroundRect.height 
      } : null,
      transformState: { scale: transform.scale, offset: { x: transform.offset.x, y: transform.offset.y } }
    });
    
    // SOLUCIÓN CORREGIDA:
    // 1. Calcular la posición relativa al fondo (que siempre está correctamente posicionado)
    const relativeToBackgroundX = clientX - (backgroundRect?.left || 0);
    const relativeToBackgroundY = clientY - (backgroundRect?.top || 0);
    
    // 2. Añadir el offset actual porque el canvas está desplazado
    const withOffsetX = relativeToBackgroundX + transform.offset.x;
    const withOffsetY = relativeToBackgroundY + transform.offset.y;
    
    // 3. Dividir por la escala para obtener las coordenadas en el espacio original del canvas
    const finalX = withOffsetX / transform.scale;
    const finalY = withOffsetY / transform.scale;
    
    console.log("Calculated coordinates (improved):", {
      relativeToBackground: { x: relativeToBackgroundX, y: relativeToBackgroundY },
      withOffset: { x: withOffsetX, y: withOffsetY },
      final: { x: finalX, y: finalY }
    });

    return {
      x: finalX,
      y: finalY,
    }
  }

  const drawLine = (
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    currentTool: Tool,
  ) => {
    // Registrar este trazo para depuración
    const currentTime = Date.now();
    
    // Calcular la distancia del trazo
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Un trazo es sospechoso si es muy largo (posible línea fantasma)
    // o si hay una larga pausa desde el último trazo
    const timeSinceLastDraw = currentTime - lastDrawCallTimeRef.current;
    const isSuspicious = distance > 50 || timeSinceLastDraw > 500;
    
    // Registrar este trazo
    const strokeInfo = {
      from: { x: fromX, y: fromY },
      to: { x: toX, y: toY },
      distance: distance,
      time: currentTime,
      isSuspicious: isSuspicious,
      timeDelta: timeSinceLastDraw
    };
    
    // Actualizar historial de trazos
    strokeHistoryRef.current = [...strokeHistoryRef.current, strokeInfo].slice(-MAX_STROKE_HISTORY);
    
    // Actualizar tiempo de la última llamada
    lastDrawCallTimeRef.current = currentTime;
    
    // Si es un trazo sospechoso, actualizar inmediatamente los datos de depuración
    if (isSuspicious) {
      updateDebugData("suspiciousStroke");
    }
    
    // Dibujar la línea
    if (currentTool === "pen") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "black";
      ctx.lineWidth = 2;
    } else if (currentTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = 20;
    }

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    if (!isDrawingMode && isPanning) {
      // Usar la función applyPanWithConstraints para mantener consistencia
      applyPanWithConstraints(e.movementX, e.movementY);
      return;
    }

    if (!isDrawing || !isDrawingMode) return

    const canvas = canvasRef.current
    if (!canvas) return

    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY)

    const ctx = canvas.getContext("2d")
    if (ctx && lastPoint.current) {
      drawLine(ctx, lastPoint.current.x, lastPoint.current.y, x, y, tool)
      
      socketRef.current.emit("draw", {
        fromX: lastPoint.current.x,
        fromY: lastPoint.current.y,
        toX: x,
        toY: y,
        tool,
      })
      // Update the stroke bounds
      if (strokeBoundsRef.current) {
        if (tool === "pen") {
          strokeBoundsRef.current.minX = Math.min(strokeBoundsRef.current.minX, x);
          strokeBoundsRef.current.minY = Math.min(strokeBoundsRef.current.minY, y);
          strokeBoundsRef.current.maxX = Math.max(strokeBoundsRef.current.maxX, x);
          strokeBoundsRef.current.maxY = Math.max(strokeBoundsRef.current.maxY, y);
        }
      }
    }
    lastPoint.current = { x, y }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    if (!isDrawingMode) {
      setIsPanning(true)
      return
    }

    setIsDrawing(true)
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY)
    lastPoint.current = { x, y }
    if (tool === "pen") {
      strokeBoundsRef.current = { minX: x, minY: y, maxX: x, maxY: y }
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    setIsDrawing(false)
    setIsPanning(false)
    lastPoint.current = null
  }

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    setIsDrawing(false)
    setIsPanning(false)
    lastPoint.current = null
  }

  const handleToolChange = (newTool: Tool) => {
    setTool(newTool);
    setIsDrawing(false);
    setIsPanning(false);
    lastPoint.current = null;
    // IMPORTANTE: Limpiar pendingDraw al cambiar de herramienta
    pendingDrawRef.current = null;
    
    // Si cambiamos a modo dibujo, activar el registro de depuración
    if (newTool !== "pan") {
      debuggingActiveRef.current = true;
      updateDebugData("toolChange");
    } else {
      // Si salimos del modo dibujo, desactivar el registro
      debuggingActiveRef.current = false;
    }
  };

  const handleAccept = async () => {
    // Add date text only if there has been any drawing
    if (strokeBoundsRef.current) {
      const now = new Date()
      const formattedDateTime = now.toLocaleString("default", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })

      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext("2d")
        if (ctx) {
          try {
            ctx.save()
            ctx.font = "20px sans-serif"
            ctx.fillStyle = "white"
            ctx.textAlign = "center"
            const textX = (strokeBoundsRef.current.minX + strokeBoundsRef.current.maxX) / 2
            const textY = strokeBoundsRef.current.maxY + 40
            ctx.fillText(formattedDateTime, textX, textY)
            ctx.restore()

            // Guardar el estado del canvas directamente en Supabase
            const imageData = canvas.toDataURL('image/png')
            console.log('Saving to Supabase...')
            
            const { error } = await supabase
              .from('canvas_states')
              .insert([
                {
                  state: imageData,
                  created_at: new Date().toISOString()
                }
              ])

            if (error) {
              console.error('Error saving to Supabase:', error)
              throw error
            }

            console.log('Successfully saved to Supabase')
            
            // También emitir por socket para actualización en tiempo real
            socketRef.current.emit('saveCanvasState', imageData)

          } catch (error) {
            console.error('Error in handleAccept:', error)
          }
        }
      }
    }
    
    // Always switch to pan mode
    handleToolChange("pan")
  }

  const saveCanvasState = async () => {
    // Implementación de la función saveCanvasState
    console.log("Guardando estado del canvas");
    // Aquí iría la lógica para guardar el estado
  };

  // Modificar para registrar cuando se reinicia pendingDraw
  const resetPendingDraw = (reason: string) => {
    pendingDrawRef.current = null;
    lastResetReasonRef.current = reason;
    updateDebugData("resetPendingDraw");
  };

  // Añadir una función para aplicar el paneo con límites correctos
  const applyPanWithConstraints = (deltaX: number, deltaY: number) => {
    const viewportWidth = backgroundRef.current?.clientWidth || window.innerWidth;
    const viewportHeight = backgroundRef.current?.clientHeight || window.innerHeight;
    
    setTransform((prev) => {
      // Calcular los límites máximos para asegurar que el canvas cubra todo el viewport
      const maxOffsetX = Math.max(0, CANVAS_WIDTH * prev.scale - viewportWidth);
      const maxOffsetY = Math.max(0, CANVAS_HEIGHT * prev.scale - viewportHeight);
      
      // Para evitar ver bordes blancos, necesitamos:
      // 1. Nunca permitir valores negativos
      // 2. Nunca permitir que el borde derecho/inferior del canvas sea visible
      const newX = Math.max(0, Math.min(maxOffsetX, prev.offset.x - deltaX / prev.scale));
      const newY = Math.max(0, Math.min(maxOffsetY, prev.offset.y - deltaY / prev.scale));
      
      return {
        ...prev,
        offset: { x: newX, y: newY }
      };
    });
  };

  // Modificar la función applyZoomAtPoint para mayor precisión y rapidez
  const applyZoomAtPoint = (zoomFactor: number, center: { x: number, y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Obtener las dimensiones del viewport
    const viewportWidth = backgroundRef.current?.clientWidth || window.innerWidth;
    const viewportHeight = backgroundRef.current?.clientHeight || window.innerHeight;
    
    // Obtener el rectángulo del fondo para calcular posiciones relativas
    const backgroundRect = backgroundRef.current?.getBoundingClientRect();
    
    // Actualizar todo de forma atómica para evitar usar valores desactualizados
    setTransform(prev => {
      // Calcular la posición relativa al viewport del punto donde se hace el pinch
      const relativeX = center.x - (backgroundRect?.left || 0);
      const relativeY = center.y - (backgroundRect?.top || 0);
      
      // Calcular la posición en coordenadas absolutas del canvas (sin escala)
      const pointXInCanvas = (relativeX + prev.offset.x) / prev.scale;
      const pointYInCanvas = (relativeY + prev.offset.y) / prev.scale;
      
      // Calcular la nueva escala dentro de los límites permitidos
      const currentScale = prev.scale;
      const newScale = Math.min(Math.max(currentScale * zoomFactor, MIN_SCALE), MAX_SCALE);
      
      // Si la escala no cambia significativamente, no hacer nada
      if (Math.abs(newScale - currentScale) < 0.001) return prev;
      
      // Calcular los nuevos offsets para mantener el punto del pinch centrado
      // Este es el cálculo clave: después del zoom, el punto del pinch debe seguir estando en la misma posición relativa
      const newOffsetX = (pointXInCanvas * newScale) - relativeX;
      const newOffsetY = (pointYInCanvas * newScale) - relativeY;
      
      // Calcular los límites máximos para evitar espacios en blanco
      const maxOffsetX = Math.max(0, CANVAS_WIDTH * newScale - viewportWidth);
      const maxOffsetY = Math.max(0, CANVAS_HEIGHT * newScale - viewportHeight);
      
      // Aplicar las restricciones para evitar espacios en blanco
      const constrainedOffsetX = Math.max(0, Math.min(maxOffsetX, newOffsetX));
      const constrainedOffsetY = Math.max(0, Math.min(maxOffsetY, newOffsetY));
      
      // Registrar para depuración
      console.log("Zoom aplicado:", {
        factor: zoomFactor,
        centerPoint: center,
        canvasPoint: { x: pointXInCanvas, y: pointYInCanvas },
        newScale,
        newOffset: { x: constrainedOffsetX, y: constrainedOffsetY },
        consecutiveZooms: consecutiveZoomMovesRef.current
      });
      
      // Devolver la nueva transformación completa
      return {
        scale: newScale,
        offset: {
          x: constrainedOffsetX,
          y: constrainedOffsetY
        }
      };
    });
  };

  return (
    <main ref={containerRef} className="relative w-screen h-screen overflow-hidden">
      <div
        ref={backgroundRef}
        style={{
          width: "100vw",
          height: "100vh",
          overflow: "hidden",
          position: "relative",
          cursor: isDrawingMode ? "crosshair" : "move",
          backgroundImage: 'url("https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Cloudless%20Blue%20Sky%20Background-W5DbJt7OROC1E0DSpqRo71xpUJ3ePp.webp")',
          backgroundSize: `${CANVAS_WIDTH * transform.scale}px ${CANVAS_HEIGHT * transform.scale}px`,
          backgroundPosition: `-${transform.offset.x}px -${transform.offset.y}px`,
          backgroundRepeat: "no-repeat",
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{
            position: "absolute",
            transform: `translate(${-transform.offset.x}px, ${-transform.offset.y}px) scale(${transform.scale})`,
            transformOrigin: "0 0",
            touchAction: "none",
            width: `${CANVAS_WIDTH}px`,
            height: `${CANVAS_HEIGHT}px`,
          }}
        />
        
        {/* Zoom indicator */}
        <div className="fixed top-4 right-4 bg-black/50 text-white px-3 py-1 rounded-full font-mono text-sm z-50">
          {Math.round(transform.scale * 100)}%
        </div>
        
        {/* Zoom buttons */}
        <div className="fixed top-4 left-4 flex gap-2 z-50">
          <button 
            className="bg-black/50 text-white px-3 py-1 rounded-full"
            onClick={() => forceZoom(true)}
          >
            +
          </button>
          <button 
            className="bg-black/50 text-white px-3 py-1 rounded-full"
            onClick={() => forceZoom(false)}
          >
            -
          </button>
        </div>
      </div>
      <div id="controls" className="fixed bottom-8 left-8 flex flex-col gap-3">
        {!isDrawingMode ? (
          <Button 
            className="rounded-full w-16 h-16 p-0 bg-white hover:bg-white/90"
            variant="outline"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => handleToolChange("pen")}
          >
            <Pencil className="w-8 h-8" />
          </Button>
        ) : (
          <>
            <Button 
              className="rounded-full w-16 h-16 p-0"
              variant={tool === "pen" ? "default" : "outline"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => handleToolChange("pen")}
            >
              <Pencil className="w-8 h-8" />
            </Button>
            <Button 
              className="rounded-full w-16 h-16 p-0"
              variant={tool === "eraser" ? "default" : "outline"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => handleToolChange("eraser")}
            >
              <Eraser className="w-8 h-8" />
            </Button>
            <Button 
              className="rounded-full w-16 h-16 p-0 bg-green-600 hover:bg-green-700"
              variant="default"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleAccept}
            >
              <Check className="w-8 h-8" />
            </Button>
          </>
        )}
      </div>
      
      {/* Botón flotante para mostrar/ocultar panel de depuración */}
      <button 
        onClick={() => setShowDebugPanel(!showDebugPanel)}
        className="fixed top-2 right-2 bg-gray-800 text-white p-2 rounded-full z-50 text-xs"
      >
        {showDebugPanel ? "Ocultar Debug" : "Mostrar Debug"}
      </button>
      
      {/* Panel de depuración compacto */}
      {showDebugPanel && (
        <div className="fixed top-12 right-2 bg-black bg-opacity-80 text-white p-2 z-50 max-w-[350px] max-h-[80vh] overflow-auto text-xs rounded-lg border border-gray-700 shadow-lg">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-bold">Debug: {debugData.eventType} ({debugData.touchCount})</h3>
            <div className="flex space-x-1">
              <span className="bg-purple-800 px-1 rounded text-[10px]">Sesión #{debugData.sessionId}</span>
              <button 
                onClick={copyDebugData}
                className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-1 px-2 rounded text-xs"
              >
                Copiar
              </button>
            </div>
          </div>
          
          <div className="space-y-1">
            <p><strong>Modo:</strong> {debugData.isDrawingMode ? 'Dibujo' : 'Pan'}</p>
            <p><strong>Multi-táctil:</strong> {debugData.lastWasMultiTouch ? 'Sí' : 'No'}</p>
            <p><strong>Prev. Multi:</strong> {debugData.wasMultiTouchBefore ? 'Sí' : 'No'} ({debugData.previousTouchCount || 0}→{debugData.touchCount})</p>
            <p><strong>Dibujando:</strong> {debugData.isDrawing ? 'Sí' : 'No'}</p>
            <p><strong>Timeout:</strong> {debugData.hasTimeout ? 'Sí' : 'No'}</p>
            <p><strong>Último reset:</strong> <span className="text-yellow-400">{debugData.lastResetReason}</span></p>
            
            <div className="flex space-x-2 text-[10px]">
              <div>
                <p><strong>Último:</strong></p>
                <p>{debugData.lastPoint ? 
                  `x: ${debugData.lastPoint.x.toFixed(0)}, y: ${debugData.lastPoint.y.toFixed(0)}` : 'null'}</p>
              </div>
              <div>
                <p><strong>Pendiente:</strong></p>
                <p>{debugData.pendingDraw ? 
                  `x: ${debugData.pendingDraw.x.toFixed(0)}, y: ${debugData.pendingDraw.y.toFixed(0)}` : 'null'}</p>
              </div>
            </div>
            
            <div className="mt-1">
              <p><strong>Posición real:</strong></p>
              <p>{debugData.convertedPosition ? 
                `x: ${debugData.convertedPosition.x.toFixed(0)}, y: ${debugData.convertedPosition.y.toFixed(0)}` : 'null'}</p>
            </div>
          </div>
          
          <div className="mt-2">
            <p><strong>Historial de eventos:</strong></p>
            <div className="grid grid-cols-2 gap-1 text-[9px]">
              {debugData.eventHistory.map((event, idx) => (
                <div key={idx} className={`p-1 rounded ${
                  event.type === 'touchstart' ? 'bg-green-800' : 
                  event.type === 'touchmove' ? 'bg-blue-800' : 
                  event.type === 'touchend' ? 'bg-red-800' :
                  event.type === 'suspiciousStroke' ? 'bg-orange-800 border border-yellow-400' :
                  'bg-gray-800'
                }`}>
                  {event.type.slice(0, 10)} ({event.touchCount}) - {new Date(event.time).toLocaleTimeString('es-ES', {hour12: false, minute: '2-digit', second: '2-digit'})}
                </div>
              ))}
            </div>
          </div>
          
          {/* Historial de trazos - nuevo */}
          <div className="mt-3 border-t border-gray-700 pt-2">
            <p><strong>Últimos trazos:</strong> ({debugData.strokeHistory.length})</p>
            <div className="grid gap-1 text-[9px]">
              {debugData.strokeHistory.map((stroke, idx) => (
                <div key={idx} className={`p-1 rounded ${
                  stroke.isSuspicious ? 'bg-red-900 border border-red-400' : 'bg-gray-900'
                }`}>
                  {idx+1}. De ({stroke.from.x.toFixed(0)},{stroke.from.y.toFixed(0)}) a ({stroke.to.x.toFixed(0)},{stroke.to.y.toFixed(0)})
                  <div className="grid grid-cols-3 mt-0.5">
                    <span><strong>Dist:</strong> {stroke.distance.toFixed(0)}px</span>
                    <span><strong>ΔT:</strong> {stroke.timeDelta}ms</span>
                    <span>{stroke.isSuspicious ? '⚠️' : '✓'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}


