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

// Añadir esta declaración para TypeScript en algún lugar cerca del inicio del archivo
declare global {
  interface Window {
    saveCanvasWithNoteRef?: (noteText: string) => Promise<void>;
  }
}

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
  // Nueva referencia para la bounding box de todo el dibujo
  const drawingBoundsRef = useRef<{minX: number, minY: number, maxX: number, maxY: number} | null>(null)
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
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  
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

  // Añadir nuevos estados para manejar el punto y el texto
  const [notePoint, setNotePoint] = useState<{x: number, y: number} | null>(null);
  const [noteText, setNoteText] = useState<string>("");
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const noteInputRef = useRef<HTMLInputElement>(null);
  
  // Nuevo estado para soportar múltiples puntos de notas
  const [allNotes, setAllNotes] = useState<{
    id: number;
    point: {x: number, y: number};
    text: string;
    showBubble: boolean;
    isTemporary?: boolean; // Optional temporary flag
  }[]>([]);

  // Variable para almacenar el ID de la última entrada creada
  const lastCanvasStateIdRef = useRef<number | null>(null);
  const processingSaveRef = useRef<boolean>(false); // Evitar guardar múltiples veces

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

    // Connect to WebSocket server with a timeout to prevent blocking page load
    const connectSocket = () => {
      try {
        if (socketRef.current) {
          // Already trying to connect or connected
          return;
        }
        
        socketRef.current = io({
          path: '/api/socket',
          transports: ['polling', 'websocket'],
          reconnectionAttempts: 3,
          timeout: 3000,
          reconnectionDelay: 1000,
          forceNew: true,
          addTrailingSlash: false
        });
        
        // Add a connection timeout
        const connectionTimeout = setTimeout(() => {
          if (socketRef.current && !socketRef.current.connected) {
            console.log('Socket connection timed out, app will work with limited functionality');
            socketRef.current.disconnect();
          }
        }, 5000);
        
        socketRef.current.on('connect', () => {
          console.log('Socket connected successfully');
          clearTimeout(connectionTimeout);
          
          // Only request canvas state once we're connected
          safeSocketEmit('requestCanvasState', {});
        });
        
        socketRef.current.on('connect_error', (err: Error) => {
          console.log('Socket connection error, functionality may be limited:', err.message);
        });
        
        // Set up socket event listeners
        if (socketRef.current) {
          // Escuchar el estado inicial del canvas
          socketRef.current.on('canvasState', (data: any) => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            
            if (!canvas || !ctx) return;
            
            if (data.imageData) {
              const img = new Image();
              img.onload = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
              };
              img.src = data.imageData;
            }
          });
          
          // Listen for drawing events from other clients
          socketRef.current.on('draw', (data: any) => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            
            if (!canvas || !ctx) return;
            
            drawLine(
              ctx,
              data.fromX,
              data.fromY,
              data.toX,
              data.toY,
              data.tool
            );
          });
          
          // Listen for save confirmation
          socketRef.current.on('saveConfirmed', (response: any) => {
            if (response.success) {
              // Actualizar el ID del estado actual
              if (response.id) {
                lastCanvasStateIdRef.current = response.id;
              }
            }
          });
          
          // Escuchar actualizaciones de notas
          socketRef.current.on('noteUpdated', (data: any) => {
            setAllNotes(prev => {
              // Buscar si ya existe esta nota en nuestro estado
              const noteIndex = prev.findIndex(note => note.id === data.id);
              
              if (noteIndex !== -1) {
                // Actualizar la nota existente
                const updatedNotes = [...prev];
                updatedNotes[noteIndex] = {
                  ...updatedNotes[noteIndex],
                  text: data.noteText
                };
                return updatedNotes;
              } else if (data.notePoint && data.noteText) {
                // Agregar una nueva nota si tiene punto y texto
                return [...prev, {
                  id: data.id,
                  point: data.notePoint,
                  text: data.noteText,
                  showBubble: false
                }];
              }
              
              return prev;
            });
          });
          
          // Confirmation for note update
          socketRef.current.on('noteUpdateConfirmed', (response: any) => {
            if (response.success) {
              console.log('Note update confirmed on server');
            }
          });
        }
      } catch (error) {
        console.error('Failed to initialize socket:', error);
      }
    };
    
    // Try to connect in the background after a delay to prioritize UI rendering
    setTimeout(connectSocket, 1500);

    // Load initial canvas state from Supabase - immediately to speed up page load
    loadCanvasState();
    
    // Function to load canvas state directly from Supabase
    async function loadCanvasState() {
      try {
        console.log('Fetching initial state from Supabase...')
        
        // First, get only the latest canvas state to render quickly
        const { data: latestData, error: latestError } = await supabase
          .from('canvas_states')
          .select('id, state, created_at')
          .order('created_at', { ascending: false })
          .limit(1)
        
        if (latestError) {
          throw latestError
        }
        
        if (latestData && latestData.length > 0) {
          const latestCanvas = latestData[0];
          lastCanvasStateIdRef.current = latestCanvas.id;
          
          // Load the canvas image first for faster visual feedback
          const img = new Image()
          img.onload = () => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            
            if (!canvas || !ctx) return;
            
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0)
          }
          img.src = latestCanvas.state
          
          // Then load note data in the background
          loadNoteData();
        }
      } catch (error) {
        console.error('Error loading canvas state:', error)
      }
    }
    
    // Load note data separately to improve initial load time
    async function loadNoteData() {
      try {
        const { data, error } = await supabase
          .from('canvas_states')
          .select('id, note_text, note_x, note_y')
          .order('created_at', { ascending: false })
          .not('note_text', 'is', null)
          .not('note_text', 'eq', '')
        
        if (error) {
          throw error
        }
        
        if (data && data.length > 0) {
          // Cargar todas las notas que tengan texto
          const notesWithText = data
            .filter(record => record.note_text && record.note_text.trim() && record.note_x && record.note_y)
            .map(record => ({
              id: record.id,
              point: { x: record.note_x, y: record.note_y },
              text: record.note_text,
              showBubble: false // Inicialmente ningún bubble se muestra
            }));
          
          console.log('Loaded notes with text:', notesWithText.length)
          setAllNotes(notesWithText)
        }
      } catch (error) {
        console.error('Error loading note data:', error)
      }
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
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
      
      // Ocultar todas las burbujas al inicio de cualquier interacción táctil
      hideAllBubbles();
      
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
                
                // También inicializar o actualizar la bounding box del dibujo completo
                if (drawingBoundsRef.current === null) {
                  drawingBoundsRef.current = { 
                    minX: pendingDrawRef.current.x, 
                    minY: pendingDrawRef.current.y, 
                    maxX: pendingDrawRef.current.x, 
                    maxY: pendingDrawRef.current.y 
                  };
                } else {
                  drawingBoundsRef.current.minX = Math.min(drawingBoundsRef.current.minX, pendingDrawRef.current.x);
                  drawingBoundsRef.current.minY = Math.min(drawingBoundsRef.current.minY, pendingDrawRef.current.y);
                  drawingBoundsRef.current.maxX = Math.max(drawingBoundsRef.current.maxX, pendingDrawRef.current.x);
                  drawingBoundsRef.current.maxY = Math.max(drawingBoundsRef.current.maxY, pendingDrawRef.current.y);
                }
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
            // Aplicar paneo sin ajuste por scale para mantener velocidad consistente
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
          
          // Emitir el evento de dibujo al socket para sincronización
          safeSocketEmit("draw", {
            fromX: pendingDrawRef.current.x,
            fromY: pendingDrawRef.current.y,
            toX: x,
            toY: y,
            tool,
          });
          
          // Actualizar el strokeBoundsRef para mantener registro de las dimensiones del trazo
          if (strokeBoundsRef.current && tool === "pen") {
            strokeBoundsRef.current.minX = Math.min(strokeBoundsRef.current.minX, x);
            strokeBoundsRef.current.minY = Math.min(strokeBoundsRef.current.minY, y);
            strokeBoundsRef.current.maxX = Math.max(strokeBoundsRef.current.maxX, x);
            strokeBoundsRef.current.maxY = Math.max(strokeBoundsRef.current.maxY, y);
            
            // También actualizar la bounding box del dibujo completo
            if (drawingBoundsRef.current) {
              drawingBoundsRef.current.minX = Math.min(drawingBoundsRef.current.minX, x);
              drawingBoundsRef.current.minY = Math.min(drawingBoundsRef.current.minY, y);
              drawingBoundsRef.current.maxX = Math.max(drawingBoundsRef.current.maxX, x);
              drawingBoundsRef.current.maxY = Math.max(drawingBoundsRef.current.maxY, y);
            }
          }
          
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
      // Función para generar un valor pseudo-aleatorio determinístico basado en coordenadas
      // Esto garantiza que los mismos trazos se vean iguales en todos los dispositivos
      const deterministicRandom = (a: number, b: number, seed: number) => {
        const x = Math.sin(a * 12.9898 + b * 78.233 + seed) * 43758.5453;
        return x - Math.floor(x);
      };
      
      // Configuración para el pincel nuboso con textura de acuarela
      // Cambiamos de "lighter" a "source-over" para evitar el exceso de brillo
      // pero manteniendo la acumulación de color de forma más natural
      ctx.globalCompositeOperation = "source-over";
      
      // Guardar el estado actual del contexto
      ctx.save();
      
      // Calculamos el punto medio del trazo para aplicar el gradiente
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      
      // Radio variable que depende de la distancia del trazo (trazos más largos = pinceles más anchos)
      // Duplicamos el tamaño base del pincel (en lugar de triplicarlo)
      const baseRadius = Math.max(80, 40 + distance * 0.6);
      
      try {
        // Configurar un pincel con bordes difuminados para simular nubes
        // Aseguramos que todos los valores sean números válidos y positivos
        const safeRadius = Math.max(1, baseRadius); // Evitar radios muy pequeños o negativos
        
        const gradient = ctx.createRadialGradient(
          midX, midY, 0,
          midX, midY, safeRadius
        );
        
        // Colores blancos con diferentes opacidades para crear el efecto nuboso
        // Mantenemos opacidades sutiles pero ajustamos para el nuevo modo de composición
        gradient.addColorStop(0, "rgba(255, 255, 255, 0.1)");
        gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.05)");
        gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
        
        // Aplicar el gradiente como estilo de trazo
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 100; // Duplicamos el ancho de la línea (en lugar de triplicarlo)
        ctx.lineCap = "round"; // Extremos redondeados
        ctx.lineJoin = "round"; // Uniones redondeadas
        
        // Dibujar el trazo principal
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        
        // Coordenadas y distancia para el cálculo pseudo-aleatorio consistente
        const seed = (fromX + fromY + toX + toY) % 1000;
        
        // Añadir múltiples trazos con diferentes opacidades y tamaños para crear textura
        for (let i = 0; i < 5; i++) { // Aumentamos a 5 trazos para más textura
          // Usar valores determinísticos basados en las coordenadas
          // Duplicamos el desplazamiento para trazos más variados (en lugar de triplicarlo)
          const offsetX = (deterministicRandom(fromX, toX, i * 100 + seed) - 0.5) * 50;
          const offsetY = (deterministicRandom(fromY, toY, i * 200 + seed) - 0.5) * 50;
          
          // Reducir tamaño y opacidad para cada trazo adicional
          const size = Math.max(20, baseRadius - i * 10);
          
          // Opacidades más sutiles, con variación basada en el índice del trazo
          // Esto crea un efecto más etéreo y nuboso pero que se acumula con múltiples pasadas
          const alpha = 0.04 - i * 0.005; 
          
          // Punto medio desplazado para cada subtrazo
          const offsetMidX = midX + offsetX;
          const offsetMidY = midY + offsetY;
          
          try {
            // Crear un nuevo gradiente para este trazo
            // Nos aseguramos de que el radio sea positivo
            const subGradient = ctx.createRadialGradient(
              offsetMidX, offsetMidY, 0,
              offsetMidX, offsetMidY, Math.max(1, size)
            );
            
            subGradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
            subGradient.addColorStop(0.5, `rgba(255, 255, 255, ${alpha/2})`);
            subGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
            
            // Ancho variable pero determinístico - duplicamos el ancho (en lugar de triplicarlo)
            const varWidth = 40 + (deterministicRandom(fromX, toY, i * 300 + seed) * 60);
            
            ctx.strokeStyle = subGradient;
            ctx.lineWidth = varWidth;
            
            // Desplazar ligeramente los puntos de inicio y fin para cada trazo
            const fromOffsetX = fromX + offsetX * 0.7;
            const fromOffsetY = fromY + offsetY * 0.7;
            const toOffsetX = toX + offsetX * 0.7;
            const toOffsetY = toY + offsetY * 0.7;
            
            // Dibujar trazo adicional con desplazamiento
            ctx.beginPath();
            ctx.moveTo(fromOffsetX, fromOffsetY);
            ctx.lineTo(toOffsetX, toOffsetY);
            ctx.stroke();
          } catch (e) {
            console.error("Error en el gradiente secundario:", e);
            // Si falla, intentamos con un color sólido como fallback
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.lineWidth = 50; // Duplicamos el ancho del fallback
            ctx.beginPath();
            ctx.moveTo(fromX, fromY);
            ctx.lineTo(toX, toY);
            ctx.stroke();
          }
        }
        
        // Añadir un punto de textura para crear un efecto más interesante en los nodos
        // Solo lo hacemos ocasionalmente para crear variación
        if (distance < 20 && deterministicRandom(fromX, fromY, seed) > 0.7) {
          // Crear un punto más denso en los extremos para simular acumulación de acuarela
          const nodeGradient = ctx.createRadialGradient(
            fromX, fromY, 0,
            fromX, fromY, baseRadius * 0.4
          );
          
          nodeGradient.addColorStop(0, "rgba(255, 255, 255, 0.05)");
          nodeGradient.addColorStop(0.5, "rgba(255, 255, 255, 0.025)");
          nodeGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
          
          ctx.fillStyle = nodeGradient;
          ctx.beginPath();
          ctx.arc(fromX, fromY, baseRadius * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } catch (e) {
        console.error("Error en el gradiente principal:", e);
        // Si el gradiente falla, utilizamos un pincel sólido como fallback
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.07)"; // Bajamos opacidad del fallback
        ctx.lineWidth = 80; // Duplicamos el ancho del fallback
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
      }
      
      // Restaurar el estado original del contexto
      ctx.restore();
      
      // Actualizar los límites de todo el dibujo cuando se usa el lápiz
      if (drawingBoundsRef.current === null) {
        drawingBoundsRef.current = { 
          minX: Math.min(fromX, toX), 
          minY: Math.min(fromY, toY), 
          maxX: Math.max(fromX, toX), 
          maxY: Math.max(fromY, toY) 
        };
      } else {
        drawingBoundsRef.current.minX = Math.min(drawingBoundsRef.current.minX, fromX, toX);
        drawingBoundsRef.current.minY = Math.min(drawingBoundsRef.current.minY, fromY, toY);
        drawingBoundsRef.current.maxX = Math.max(drawingBoundsRef.current.maxX, fromX, toX);
        drawingBoundsRef.current.maxY = Math.max(drawingBoundsRef.current.maxY, fromY, toY);
      }
    } else if (currentTool === "eraser") {
      // Aplicamos un efecto nuboso similar al pincel pero para borrar
      // Usamos una opacidad mejorada para un borrado más efectivo pero aún gradual
      ctx.globalCompositeOperation = "destination-out";
      
      // Guardar el estado actual del contexto
      ctx.save();
      
      // Calculamos el punto medio del trazo para aplicar el gradiente
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      
      // Radio variable que depende de la distancia del trazo
      const baseRadius = Math.max(80, 40 + distance * 0.6);
      
      try {
        // Configurar un borrador con bordes difuminados
        const safeRadius = Math.max(1, baseRadius);
        
        // FASE 1: Primero aplicamos un trazo sólido con alta opacidad para eliminar completamente el centro
        // Esto asegura que no queden siluetas o residuos
        const solidEraser = ctx.createRadialGradient(
          midX, midY, 0,
          midX, midY, safeRadius * 0.7 // Radio más pequeño para el borrado completo
        );
        
        // Centro completamente opaco para borrado total
        solidEraser.addColorStop(0, "rgba(0, 0, 0, 0.3)"); // Opacidad muy alta para eliminar completamente
        solidEraser.addColorStop(0.6, "rgba(0, 0, 0, 0.15)");
        solidEraser.addColorStop(1, "rgba(0, 0, 0, 0)");
        
        // Aplicar el borrador sólido primero
        ctx.strokeStyle = solidEraser;
        ctx.lineWidth = 70; // Ancho más pequeño que el trazo principal
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        
        // FASE 2: Aplicar el gradiente normal con bordes suaves
        const gradient = ctx.createRadialGradient(
          midX, midY, 0,
          midX, midY, safeRadius
        );
        
        // Aumentamos aún más las opacidades para un borrado más efectivo
        gradient.addColorStop(0, "rgba(0, 0, 0, 0.15)"); // Era 0.07
        gradient.addColorStop(0.5, "rgba(0, 0, 0, 0.08)"); // Era 0.04
        gradient.addColorStop(1, "rgba(0, 0, 0, 0.02)");  // Era 0.01
        
        // Aplicar el gradiente como estilo de trazo
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 100;
        
        // Dibujar el trazo principal
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        
        // Añadir efecto de textura al borrador
        const seed = (fromX + fromY + toX + toY) % 1000;
        
        // Función para generar un valor pseudo-aleatorio determinístico basado en coordenadas
        const deterministicRandom = (a: number, b: number, seed: number) => {
          const x = Math.sin(a * 12.9898 + b * 78.233 + seed) * 43758.5453;
          return x - Math.floor(x);
        };
        
        // Dibujar trazos adicionales con desplazamiento para un borrado más natural
        for (let i = 0; i < 5; i++) { // Usamos 5 trazos como en el pincel
          // Usar valores determinísticos basados en las coordenadas
          const offsetX = (deterministicRandom(fromX, toX, i * 100 + seed) - 0.5) * 50;
          const offsetY = (deterministicRandom(fromY, toY, i * 200 + seed) - 0.5) * 50;
          
          const size = Math.max(20, baseRadius - i * 10);
          
          // Aumentamos aún más las opacidades para borrar efectivamente
          const alpha = 0.08 - i * 0.01; // Era 0.05 - i * 0.006
          
          const offsetMidX = midX + offsetX;
          const offsetMidY = midY + offsetY;
          
          try {
            const subGradient = ctx.createRadialGradient(
              offsetMidX, offsetMidY, 0,
              offsetMidX, offsetMidY, Math.max(1, size)
            );
            
            subGradient.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
            subGradient.addColorStop(0.5, `rgba(0, 0, 0, ${alpha/1.5})`); // División menos agresiva
            subGradient.addColorStop(1, "rgba(0, 0, 0, 0.005)"); // Un mínimo de opacidad en los bordes
            
            // Ancho variable pero determinístico - igual que el pincel
            const varWidth = 40 + (deterministicRandom(fromX, toY, i * 300 + seed) * 60);
            
            ctx.strokeStyle = subGradient;
            ctx.lineWidth = varWidth;
            
            const fromOffsetX = fromX + offsetX * 0.7;
            const fromOffsetY = fromY + offsetY * 0.7;
            const toOffsetX = toX + offsetX * 0.7;
            const toOffsetY = toY + offsetY * 0.7;
            
            ctx.beginPath();
            ctx.moveTo(fromOffsetX, fromOffsetY);
            ctx.lineTo(toOffsetX, toOffsetY);
            ctx.stroke();
          } catch (e) {
            // Fallback en caso de error con el gradiente, con opacidad mejorada
            ctx.strokeStyle = "rgba(0, 0, 0, 0.04)"; // Era 0.02
            ctx.lineWidth = 50;
            ctx.beginPath();
            ctx.moveTo(fromX, fromY);
            ctx.lineTo(toX, toY);
            ctx.stroke();
          }
        }
        
        // Añadir un punto de textura para crear un efecto más interesante en los nodos
        if (distance < 20 && deterministicRandom(fromX, fromY, seed) > 0.7) {
          const nodeGradient = ctx.createRadialGradient(
            fromX, fromY, 0,
            fromX, fromY, baseRadius * 0.4
          );
          
          // Opacidades aumentadas para los nodos también
          nodeGradient.addColorStop(0, "rgba(0, 0, 0, 0.06)"); // Era 0.025
          nodeGradient.addColorStop(0.5, "rgba(0, 0, 0, 0.03)"); // Era 0.01
          nodeGradient.addColorStop(1, "rgba(0, 0, 0, 0.005)"); // Añadido un mínimo
          
          ctx.fillStyle = nodeGradient;
          ctx.beginPath();
          ctx.arc(fromX, fromY, baseRadius * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        
        // Añadir un trazo adicional con más opacidad para eliminar rastros persistentes
        // Este efecto se dibuja con un radio más pequeño para mantener los bordes suaves
        if (deterministicRandom(fromX, toX, seed * 2) > 0.4) { // Solo algunas veces para mantener textura
          const coreGradient = ctx.createRadialGradient(
            midX, midY, 0,
            midX, midY, safeRadius * 0.6
          );
          
          coreGradient.addColorStop(0, "rgba(0, 0, 0, 0.1)"); // Núcleo más fuerte
          coreGradient.addColorStop(0.7, "rgba(0, 0, 0, 0.03)");
          coreGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
          
          ctx.strokeStyle = coreGradient;
          ctx.lineWidth = 60; // Más delgado que el trazo principal
          
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(toX, toY);
          ctx.stroke();
        }
      } catch (e) {
        // Fallback simple en caso de error, pero con opacidad mejorada
        ctx.strokeStyle = "rgba(0, 0, 0, 0.05)"; // Era 0.02
        ctx.lineWidth = 80;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
      }
      
      // Restaurar el estado original del contexto
      ctx.restore();
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    if (!isDrawingMode && isPanning) {
      // Usar la función applyPanWithConstraints para mantener consistencia
      // No multiplicar por scale para mantener velocidad de paneo constante
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
      
      safeSocketEmit("draw", {
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
          
          // También actualizar la bounding box del dibujo completo
          if (drawingBoundsRef.current) {
            drawingBoundsRef.current.minX = Math.min(drawingBoundsRef.current.minX, x);
            drawingBoundsRef.current.minY = Math.min(drawingBoundsRef.current.minY, y);
            drawingBoundsRef.current.maxX = Math.max(drawingBoundsRef.current.maxX, x);
            drawingBoundsRef.current.maxY = Math.max(drawingBoundsRef.current.maxY, y);
          }
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
      hideAllBubbles() // Ocultar burbujas inmediatamente
      return
    }

    setIsDrawing(true)
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY)
    lastPoint.current = { x, y }
    
    // Inicializar o actualizar la bounding box del trazo actual
    if (tool === "pen") {
      strokeBoundsRef.current = { minX: x, minY: y, maxX: x, maxY: y }
      
      // También inicializar o actualizar la bounding box del dibujo completo
      if (drawingBoundsRef.current === null) {
        drawingBoundsRef.current = { minX: x, minY: y, maxX: x, maxY: y }
      } else {
        drawingBoundsRef.current.minX = Math.min(drawingBoundsRef.current.minX, x)
        drawingBoundsRef.current.minY = Math.min(drawingBoundsRef.current.minY, y)
        drawingBoundsRef.current.maxX = Math.max(drawingBoundsRef.current.maxX, x)
        drawingBoundsRef.current.maxY = Math.max(drawingBoundsRef.current.maxY, y)
      }
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
    // Si estamos cambiando de otro modo a modo dibujo, reiniciamos la bounding box del dibujo
    if (tool !== "pen" && newTool === "pen") {
      // Solo reiniciar la bounding box si venimos de aceptar un dibujo
      // Esto es importante para comenzar un dibujo nuevo con una bounding box fresca
      drawingBoundsRef.current = null;
    }
    
    setTool(newTool);
    setIsDrawing(false);
    setIsPanning(false);
    lastPoint.current = null;
    // IMPORTANTE: Limpiar pendingDraw al cambiar de herramienta
    pendingDrawRef.current = null;
    
    // Reiniciar los límites del trazo actual
    strokeBoundsRef.current = null;
    
    // Nota: No reiniciamos drawingBoundsRef aquí para mantener los límites del dibujo completo
    // a menos que vengamos de modo pan y cambiemos a pen (cubierto arriba)
    
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
    // Evitar múltiples operaciones de guardado simultáneas
    if (processingSaveRef.current) {
      console.log('Ya hay un guardado en proceso, ignorando solicitud');
      return;
    }
    
    processingSaveRef.current = true;
    
    // Add date text only if there has been any drawing
    if (drawingBoundsRef.current) {
      const now = new Date()
      // Formatear fecha como DD/MM/YYYY
      const formattedDate = now.toLocaleString("default", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      }).replace(/\s/g, '')
      
      // Formatear hora por separado
      const formattedTime = now.toLocaleString("default", {
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
            
            // Usar la bounding box completa del dibujo para posicionar el texto
            // Centrar horizontalmente y colocar debajo del dibujo
            const textX = (drawingBoundsRef.current.minX + drawingBoundsRef.current.maxX) / 2
            // Añadir un margen de 80px debajo del punto más bajo del dibujo
            const textY = drawingBoundsRef.current.maxY + 80
            
            // Dibujar la fecha en la primera línea
            ctx.fillText(formattedDate, textX, textY)
            // Dibujar la hora en la segunda línea (25px más abajo)
            ctx.fillText(formattedTime, textX, textY + 25)
            ctx.restore()

            // Guardar el estado del canvas directamente en Supabase
            const imageData = canvas.toDataURL('image/png')
            console.log('Saving to Supabase...')
            
            // Configurar el punto de nota justo a la derecha de la fecha/hora
            // Posicionar el punto de nota a 20px a la derecha de la fecha
            const noteX = textX + 80;
            const noteY = textY + 10; // A la altura de la fecha
            
            // Guardar la posición del punto de nota
            const notePoint = { x: noteX, y: noteY };
            setNotePoint(notePoint);
            
            // Agregar inmediatamente un punto temporal mientras se guarda
            const temporaryId = Date.now(); // ID temporal único
            setAllNotes(prev => [
              ...prev,
              {
                id: temporaryId,
                point: notePoint,
                text: '(Guardando...)',
                showBubble: false,
                isTemporary: true // Marcar como temporal
              }
            ]);
            
            // Mostrar el modal de entrada de texto ANTES de guardar
            setNoteText(''); // Resetear cualquier texto previo
            setShowNoteInput(true);
            
            // Guardar el canvas solo después de que el usuario introduzca la nota
            // Esta función será llamada por saveNoteText
            const saveCanvasWithNote = async (noteTextContent: string) => {
              try {
                // Asegurarnos de que el texto es una cadena, incluso si está vacío
                const finalNoteText = (noteTextContent || '').toString();
                console.log('Guardando canvas con texto de nota:', finalNoteText, 'longitud:', finalNoteText.length);
                
                // Guardar también las coordenadas del punto y los límites del dibujo
                const drawingBoundsJSON = JSON.stringify(drawingBoundsRef.current);
                console.log('Inserting record with note text:', finalNoteText);
                
                // Detectar valores inusuales para depuración
                if (finalNoteText.includes('undefined') || finalNoteText.includes('null')) {
                  console.warn('ADVERTENCIA: El texto de la nota contiene valores inusuales:', finalNoteText);
                }
                
                const insertObj = {
                  state: imageData,
                  created_at: new Date().toISOString(),
                  note_text: finalNoteText,
                  note_x: noteX,
                  note_y: noteY,
                  drawing_bounds: drawingBoundsJSON
                };
                
                console.log('Objeto completo a insertar:', JSON.stringify(insertObj));
                
                const { data, error } = await supabase
                  .from('canvas_states')
                  .insert([insertObj])
                  .select();

                if (error) {
                  console.error('Error saving to Supabase:', error)
                  throw error
                }

                console.log('Successfully saved to Supabase with note text, data:', data)
                
                // Almacenar el ID del registro recién creado
                if (data && data.length > 0) {
                  const newNoteId = data[0].id;
                  lastCanvasStateIdRef.current = newNoteId;
                  console.log('Stored canvas state ID:', lastCanvasStateIdRef.current);
                  console.log('VERIFICACIÓN FINAL - Texto de nota guardado:', data[0].note_text);
                  
                  // Si hay texto, añadir esta nota al array de notas
                  if (finalNoteText.trim()) {
                    // Reemplazar la nota temporal con la nota real
                    setAllNotes(prev => prev.map(note => 
                      note.isTemporary 
                        ? {
                            id: newNoteId,
                            point: { x: noteX, y: noteY },
                            text: finalNoteText,
                            showBubble: false
                          }
                        : note
                    ));
                  } else {
                    // Si no hay texto, eliminar la nota temporal
                    setAllNotes(prev => prev.filter(note => !note.isTemporary));
                  }
                  
                  // También emitir por socket para actualización en tiempo real
                  safeSocketEmit('saveCanvasState', {
                    id: newNoteId,
                    imageData,
                    notePoint: { x: noteX, y: noteY },
                    noteText: finalNoteText,
                    drawingBounds: drawingBoundsRef.current
                  });
                }
              } catch (error) {
                console.error('Error saving canvas with note:', error);
                alert('Error al guardar el dibujo. Inténtalo de nuevo.');
              } finally {
                processingSaveRef.current = false;
              }
            };
            
            // Guardar la función para ser llamada por saveNoteText
            window.saveCanvasWithNoteRef = saveCanvasWithNote;
            
            // Enfocar el input cuando se muestre
            setTimeout(() => {
              if (noteInputRef.current) {
                noteInputRef.current.focus();
              }
            }, 100);

          } catch (error) {
            console.error('Error in handleAccept:', error);
            processingSaveRef.current = false;
          }
        }
      }
    } else {
      processingSaveRef.current = false;
    }
    
    // Always switch to pan mode
    handleToolChange("pan");
  }

  // Nueva función para guardar el texto de la nota
  const saveNoteText = async () => {
    // Cerramos el modal primero
    setShowNoteInput(false);
    
    // Depurar valor actual de la nota
    console.log('Valor de noteText al guardar:', noteText, 'type:', typeof noteText, 'length:', noteText?.length);
    
    try {
      // Si saveCanvasWithNoteRef está disponible, significa que estamos en el flujo inicial de guardado
      if (window.saveCanvasWithNoteRef) {
        // Llamar a la función que guarda todo junto
        console.log('Guardando canvas con nota (flujo directo):', noteText);
        await window.saveCanvasWithNoteRef(noteText);
        // Limpiar la referencia
        delete window.saveCanvasWithNoteRef;
        // Quitar la notificación de éxito según lo solicitado
        return;
      }
      
      // Caso alternativo: ya tenemos un canvas guardado y solo queremos actualizar la nota
      if (!noteText?.trim()) {
        console.log('No se actualizó la nota porque está vacía');
        return;
      }
      
      console.log("Actualizando nota existente con ID:", lastCanvasStateIdRef.current);
      
      if (lastCanvasStateIdRef.current === null) {
        console.error('No ID almacenado para actualizar la nota');
        return;
      }
      
      // Probemos a hacerlo con una cadena literal para ver si hay algún problema con el tipo de datos
      const noteTextToSave = noteText.toString();
      console.log('Texto de nota a guardar (convertido):', noteTextToSave);
      
      // Realizar la actualización directamente con el ID almacenado
      const { data: updateData, error: updateError } = await supabase
        .from('canvas_states')
        .update({ note_text: noteTextToSave })
        .eq('id', lastCanvasStateIdRef.current)
        .select();
        
      if (updateError) {
        console.error('Error updating note text:', updateError);
        alert('Error al guardar la nota. Inténtalo de nuevo.');
        return;
      }
      
      console.log('Note text updated successfully, response:', updateData);
      
      // Verificar que la actualización se realizó correctamente
      if (updateData && updateData.length > 0) {
        console.log('Updated note_text value:', updateData[0].note_text);
        
        // Asegurarse de que el estado local esté sincronizado
        setNoteText(updateData[0].note_text);
        
        // También emitir por socket para actualización en tiempo real
        safeSocketEmit('updateNoteText', {
          id: lastCanvasStateIdRef.current,
          noteText: updateData[0].note_text,
          notePoint: notePoint
        });
        
        // Quitar la notificación de éxito según lo solicitado
      }
    } catch (error) {
      console.error('Error completo al guardar texto de nota:', error);
      alert('Error al guardar la nota. Inténtalo de nuevo.');
    }
  }
  
  // Modificar la función toggleNote para trabajar con múltiples notas
  const toggleNote = (noteId?: number) => {
    if (noteId !== undefined) {
      // Si recibimos un ID específico, alternamos esa nota específica
      setAllNotes(prev => prev.map(note => 
        note.id === noteId 
          ? { ...note, showBubble: !note.showBubble } 
          : note
      ));
    } else {
      // Mantener el comportamiento antiguo para compatibilidad
      setShowNote(!showNote);
    }
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
      // Eliminar la división por scale para mantener velocidad de paneo constante
      const newX = Math.max(0, Math.min(maxOffsetX, prev.offset.x - deltaX));
      const newY = Math.max(0, Math.min(maxOffsetY, prev.offset.y - deltaY));
      
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

  // Helper function to safely emit socket events
  const safeSocketEmit = (eventName: string, data: any) => {
    if (socketRef.current) {
      socketRef.current.emit(eventName, data);
    }
  };

  // Efecto para ocultar todas las burbujas de notas al hacer pan
  useEffect(() => {
    if (isPanning) {
      console.log("Ocultando burbujas debido a pan");
      // Ocultar todas las burbujas cuando se inicia el pan
      setAllNotes(prev => prev.map(note => ({
        ...note,
        showBubble: false
      })));
      
      // También ocultar la burbuja antigua por compatibilidad
      setShowNote(false);
    }
  }, [isPanning]);

  // Función para ocultar todas las burbujas
  const hideAllBubbles = () => {
    setAllNotes(prev => prev.map(note => ({
      ...note,
      showBubble: false
    })));
    setShowNote(false);
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
        
        {/* Renderizar todos los puntos de notas cargados */}
        {allNotes.map(note => (
          <div key={note.id}>
            {/* Punto de nota */}
            <div 
              className={`absolute w-5 h-5 rounded-full cursor-pointer shadow-sm ${
                note.isTemporary ? 'bg-yellow-400 animate-pulse' : 
                note.showBubble ? 'bg-white' : 'bg-gray-300 opacity-75'
              }`}
              style={{
                left: `${(note.point.x * transform.scale) - transform.offset.x - 2.5}px`,
                top: `${(note.point.y * transform.scale) - transform.offset.y - 6}px`,
                zIndex: 1000,
                transition: 'background-color 0.2s ease-in-out, opacity 0.2s ease-in-out'
              }}
              onClick={() => toggleNote(note.id)}
            />
            
            {/* Burbuja de texto para mostrar la nota - solo si está activada */}
            {note.showBubble && (
              <div 
                className="absolute bg-white p-3 rounded-lg shadow-lg max-w-xs z-50 border border-gray-300 animate-in fade-in duration-200"
                style={{
                  left: `${(note.point.x * transform.scale) - transform.offset.x + 20}px`,
                  top: `${(note.point.y * transform.scale) - transform.offset.y - 15}px`,
                  opacity: 1,
                  transition: 'opacity 0.2s ease-in-out'
                }}
              >
                <p className="text-sm font-medium text-gray-800">{note.text}</p>
              </div>
            )}
          </div>
        ))}
        
        {/* Punto de nota actual (para compatibilidad y modo de edición) */}
        {notePoint && showNoteInput && (
          <div 
            className="absolute w-5 h-5 bg-white rounded-full cursor-pointer shadow-sm"
            style={{
              left: `${(notePoint.x * transform.scale) - transform.offset.x - 2.5}px`,
              top: `${(notePoint.y * transform.scale) - transform.offset.y - 6}px`,
              zIndex: 1000,
              transition: 'background-color 0.2s ease-in-out, opacity 0.2s ease-in-out'
            }}
            onClick={() => toggleNote()}
          />
        )}
        
        {/* Burbuja de texto para mostrar la nota actual (para compatibilidad) */}
        {notePoint && showNote && noteText && (
          <div 
            className="absolute bg-white p-3 rounded-lg shadow-lg max-w-xs z-50 border border-gray-300 animate-in fade-in duration-200"
            style={{
              left: `${(notePoint.x * transform.scale) - transform.offset.x + 20}px`,
              top: `${(notePoint.y * transform.scale) - transform.offset.y - 15}px`,
              opacity: 1,
              transition: 'opacity 0.2s ease-in-out'
            }}
          >
            <p className="text-sm font-medium text-gray-800">{noteText}</p>
          </div>
        )}
        
        {/* Modal para introducir texto */}
        {showNoteInput && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full mx-12">
              <h3 className="text-lg font-semibold mb-4">quieres dejar alguna nota? :)</h3>
              <input
                ref={noteInputRef}
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-2 mb-4"
                placeholder="uhmm estoy pensando en..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    saveNoteText();
                  }
                }}
              />
              <div className="flex justify-end space-x-2">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    // Eliminar el punto temporal si existe
                    setAllNotes(prev => prev.filter(note => !note.isTemporary));
                    // Cerrar el modal
                    setShowNoteInput(false);
                    // Limpiar la referencia si existe
                    if (window.saveCanvasWithNoteRef) {
                      delete window.saveCanvasWithNoteRef;
                    }
                  }}
                >
                  Cancelar
                </Button>
                <Button 
                  onClick={saveNoteText}
                >
                  Guardar
                </Button>
              </div>
            </div>
          </div>
        )}
        
        {/* Zoom indicator */}
        <div className="fixed top-4 right-4 bg-black/50 text-white px-3 py-1 rounded-full font-mono text-sm z-50">
          {Math.round(transform.scale * 100)}%
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
    </main>
  )
}


