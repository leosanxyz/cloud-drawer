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

type Tool = "pen" | "eraser" | "pan"

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offset, setOffset] = useState({ 
    x: (CANVAS_WIDTH - VIEWPORT_WIDTH) / 2, 
    y: (CANVAS_HEIGHT - VIEWPORT_HEIGHT) / 2 
  })
  const [scale, setScale] = useState(1)
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
  const debugZoomRef = useRef<{
    lastAction: string,
    values: any[]
  }>({ lastAction: 'none', values: [] });
  const [zoomDebugInfo, setZoomDebugInfo] = useState<string>("");
  const pinchStartScaleRef = useRef<number>(1);

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
      // Store touch points
      touchesRef.current = Array.from(e.touches);
      
      // Si tenemos dos dedos, siempre asumimos que es para pinch/pan,
      // independientemente de si estamos en modo dibujo
      if (e.touches.length >= 2) {
        // Asegurarnos de que el dibujo se detiene
        setIsDrawing(false);
        lastPoint.current = null;
        
        // Calculate initial pinch distance and center
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const distance = getPinchDistance(touch1, touch2);
        const center = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2
        };
        
        // Guardar la escala actual como punto de referencia inicial
        pinchStartScaleRef.current = scale;
        
        lastPinchDistanceRef.current = distance;
        lastTouchCenterRef.current = center;
        
        // Prevent default to avoid browser zooming
        e.preventDefault();
      }
      // Si tenemos un solo toque y estamos en modo dibujo
      else if (e.touches.length === 1 && isDrawingMode) {
        const touch = e.touches[0];
        const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        lastPoint.current = { x, y };
        setIsDrawing(true);
        if (tool === "pen") {
          strokeBoundsRef.current = { minX: x, minY: y, maxX: x, maxY: y };
        }
      }
      // Si tenemos un solo toque y no estamos en modo dibujo (modo paneo)
      else if (e.touches.length === 1 && !isDrawingMode) {
        // Iniciar el paneo con un solo dedo cuando estamos en modo pan
        const touch = e.touches[0];
        lastTouchCenterRef.current = {
          x: touch.clientX,
          y: touch.clientY
        };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      // Siempre prevenir el comportamiento por defecto para evitar desplazamiento de página
      e.preventDefault();

      // Si tenemos exactamente un toque y estamos dibujando
      if (e.touches.length === 1 && isDrawing && isDrawingMode) {
        const touch = e.touches[0];
        const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        
        const ctx = canvas.getContext("2d");
        if (ctx && lastPoint.current) {
          drawLine(ctx, lastPoint.current.x, lastPoint.current.y, x, y, tool);
          
          socketRef.current.emit("draw", {
            fromX: lastPoint.current.x,
            fromY: lastPoint.current.y,
            toX: x,
            toY: y,
            tool,
          });
          
          // Update the stroke bounds
          if (strokeBoundsRef.current && tool === "pen") {
            strokeBoundsRef.current.minX = Math.min(strokeBoundsRef.current.minX, x);
            strokeBoundsRef.current.minY = Math.min(strokeBoundsRef.current.minY, y);
            strokeBoundsRef.current.maxX = Math.max(strokeBoundsRef.current.maxX, x);
            strokeBoundsRef.current.maxY = Math.max(strokeBoundsRef.current.maxY, y);
          }
        }
        lastPoint.current = { x, y };
      } 
      // Si tenemos un solo toque y estamos en modo paneo (no dibujo)
      else if (e.touches.length === 1 && !isDrawingMode && lastTouchCenterRef.current) {
        const touch = e.touches[0];
        const currentCenter = {
          x: touch.clientX,
          y: touch.clientY
        };
        
        // Calcular el desplazamiento
        const dx = currentCenter.x - lastTouchCenterRef.current.x;
        const dy = currentCenter.y - lastTouchCenterRef.current.y;
        
        // Aplicar el paneo
        setOffset(prev => {
          const viewportWidth = Math.floor(backgroundRef.current?.clientWidth || window.innerWidth);
          const viewportHeight = Math.floor(backgroundRef.current?.clientHeight || window.innerHeight);
          
          return {
            x: Math.max(0, Math.min(CANVAS_WIDTH * scale - viewportWidth, prev.x - dx)),
            y: Math.max(0, Math.min(CANVAS_HEIGHT * scale - viewportHeight, prev.y - dy))
          };
        });
        
        // Actualizar la referencia para el próximo movimiento
        lastTouchCenterRef.current = currentCenter;
      }
      // Si tenemos dos o más toques, manejar pinch/pan
      else if (e.touches.length >= 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        
        // Calculate current pinch distance and center
        const currentDistance = getPinchDistance(touch1, touch2);
        const currentCenter = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2
        };
        
        // Handle zoom if we have a previous distance
        if (lastPinchDistanceRef.current !== null) {
          // ---- LÓGICA MEJORADA PARA ZOOM ----
          
          // Cálculo del factor utilizando la distancia inicial
          const initialDistance = lastPinchDistanceRef.current;
          
          // Aproximación más directa: calcular el zoom desde el inicio del gesto
          const scaleFactor = currentDistance / initialDistance;
          
          // Ajustes para hacer más sensible el zoom out
          const distanceRatio = currentDistance / initialDistance;
          const zoomOutBoost = distanceRatio > 1 ? 2.0 : 1.0; // Amplificar zoom out aún más
          
          // Calcular la nueva escala directamente en relación a la escala inicial del gesto
          const newScale = pinchStartScaleRef.current * (distanceRatio * zoomOutBoost);
          
          // Información completa para debug
          const debugInfo = {
            currentDist: Math.round(currentDistance),
            initialDist: Math.round(initialDistance),
            ratio: distanceRatio.toFixed(3),
            direction: distanceRatio > 1 ? "OUT" : "IN",
            boost: zoomOutBoost,
            startScale: pinchStartScaleRef.current.toFixed(2),
            proposedScale: newScale.toFixed(2)
          };
          
          // Mostrar información de debug
          setZoomDebugInfo(`
            Curr: ${debugInfo.currentDist}px
            Init: ${debugInfo.initialDist}px
            Ratio: ${debugInfo.ratio}
            Dir: ${debugInfo.direction}
            Boost: ${debugInfo.boost}
            Start: ${debugInfo.startScale}
            New: ${debugInfo.proposedScale}
          `);
          
          // Aplicación directa del zoom, sin condiciones complejas
          // Obtener dimensiones del viewport
          const rect = canvas.getBoundingClientRect();
          const viewportWidth = rect.width;
          const viewportHeight = rect.height;
          
          // Calcular mínima escala permitida
          const minScaleX = viewportWidth / CANVAS_WIDTH;
          const minScaleY = viewportHeight / CANVAS_HEIGHT;
          const minScale = Math.max(minScaleX, minScaleY, MIN_SCALE);
          
          // Aplicar la escala, restringiendo a los límites min/max
          const restrictedScale = Math.max(Math.min(newScale, MAX_SCALE), minScale);
          setScale(restrictedScale);
          
          // Aplicar paneo de manera simplificada
          if (lastTouchCenterRef.current !== null) {
            const dx = (currentCenter.x - lastTouchCenterRef.current.x) * 0.5; // Factor fijo para mejor estabilidad
            const dy = (currentCenter.y - lastTouchCenterRef.current.y) * 0.5;
            
            // Apply pan
            setOffset(prev => {
              const viewportWidth = Math.floor(backgroundRef.current?.clientWidth || window.innerWidth);
              const viewportHeight = Math.floor(backgroundRef.current?.clientHeight || window.innerHeight);
              
              return {
                x: Math.max(0, Math.min(CANVAS_WIDTH * restrictedScale - viewportWidth, prev.x - dx)),
                y: Math.max(0, Math.min(CANVAS_HEIGHT * restrictedScale - viewportHeight, prev.y - dy))
              };
            });
          }
          
          // Actualizar solamente la referencia del centro para el paneo
          lastTouchCenterRef.current = currentCenter;
        } else {
          // Primera detección de dos dedos, inicializar
          lastPinchDistanceRef.current = currentDistance;
          lastTouchCenterRef.current = currentCenter;
          pinchStartScaleRef.current = scale;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      // Reset touch tracking if no touches remain
      if (e.touches.length === 0) {
        touchesRef.current = [];
        lastPinchDistanceRef.current = null;
        lastTouchCenterRef.current = null;
        setIsDrawing(false);
        lastPoint.current = null;
        // Resetear estados para el próximo gesto
        initialGestureRef.current = 'unknown';
        recentZoomFactorsRef.current = [];
        // También dejar de mostrar el debug
        setZoomDebugInfo("");
      } 
      // Update touch points if some touches remain
      else {
        touchesRef.current = Array.from(e.touches);
        
        // Si quedamos con un solo toque después de tener varios
        if (e.touches.length === 1) {
          // Resetear las referencias para el próximo gesto de pinch zoom
          lastPinchDistanceRef.current = null;
          initialGestureRef.current = 'unknown';
          recentZoomFactorsRef.current = [];
          
          // Si no estamos en modo dibujo, actualizar el punto inicial para paneo con un dedo
          if (!isDrawingMode) {
            const touch = e.touches[0];
            lastTouchCenterRef.current = {
              x: touch.clientX,
              y: touch.clientY
            };
          } else {
            // En modo dibujo, resetear el centro táctil
            lastTouchCenterRef.current = null;
          }
        }
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
  }, [isDrawingMode, tool, isDrawing, scale]);

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
      const currentScale = scale;
      const zoomInFactor = 1.1;
      const zoomOutFactor = 0.9;
      
      // Calculate new scale based on direction - usando valor fijo MIN_SCALE como límite inferior
      let newScale;
      if (zoomIn) {
        // For zoom in: multiply by factor but cap at MAX_SCALE
        newScale = Math.min(currentScale * zoomInFactor, MAX_SCALE);
      } else {
        // For zoom out: multiply by factor but floor at fixed MIN_SCALE
        newScale = Math.max(currentScale * zoomOutFactor, MIN_SCALE);
      }
      
      // Debug log with detailed information
      console.log("Wheel zoom calculation:", {
        direction: zoomIn ? "in" : "out",
        currentScale,
        proposedScale: zoomIn ? currentScale * zoomInFactor : currentScale * zoomOutFactor,
        newScale,
        minScale: MIN_SCALE,
        baseMinScale
      });
      
      // Only proceed if scale would change significantly
      if (Math.abs(newScale - currentScale) > 0.0001) {
        // Calculate scale factor between old and new scales
        const scaleFactor = newScale / currentScale;
        
        // Calculate new offsets to zoom toward/from mouse position
        const newOffsetX = mouseX - (mouseX - offset.x) * scaleFactor;
        const newOffsetY = mouseY - (mouseY - offset.y) * scaleFactor;
        
        // Log offset calculation details
        console.log("Offset calculation:", {
          mousePosition: { x: mouseX, y: mouseY },
          currentOffset: offset,
          newOffset: { x: newOffsetX, y: newOffsetY },
          scaleFactor
        });
        
        // Get current viewport dimensions
        const viewportWidth = rect.width;
        const viewportHeight = rect.height;
        
        // Constraint offsets to valid range
        const maxOffsetX = Math.max(0, CANVAS_WIDTH * newScale - viewportWidth);
        const maxOffsetY = Math.max(0, CANVAS_HEIGHT * newScale - viewportHeight);
        
        const constrainedOffsetX = Math.max(0, Math.min(maxOffsetX, newOffsetX));
        const constrainedOffsetY = Math.max(0, Math.min(maxOffsetY, newOffsetY));
        
        // Update state
        setScale(newScale);
        setOffset({
          x: constrainedOffsetX,
          y: constrainedOffsetY
        });
        
        console.log("State updated:", {
          newScale,
          newOffset: { x: constrainedOffsetX, y: constrainedOffsetY },
          maxOffset: { x: maxOffsetX, y: maxOffsetY }
        });
      } else {
        console.log("Scale change too small, ignoring");
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [scale, offset]);

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
    
    console.log("Force zoom - viewport dimensions:", {
      viewportWidth,
      viewportHeight,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      MIN_SCALE
    });
    
    // Current scale and zoom factors
    const currentScale = scale;
    const zoomInFactor = 1.1;
    const zoomOutFactor = 0.9;
    
    // Calculate new scale based on direction - usando valor fijo MIN_SCALE
    let newScale;
    if (zoomIn) {
      // For zoom in: multiply by factor but cap at MAX_SCALE
      newScale = Math.min(currentScale * zoomInFactor, MAX_SCALE);
    } else {
      // For zoom out: multiply by factor but floor at fixed MIN_SCALE
      newScale = Math.max(currentScale * zoomOutFactor, MIN_SCALE);
    }
    
    console.log("Force zoom calculation:", {
      direction: zoomIn ? "in" : "out",
      currentScale,
      proposedScale: zoomIn ? currentScale * zoomInFactor : currentScale * zoomOutFactor,
      newScale,
      minScale: MIN_SCALE,
      factor: zoomIn ? zoomInFactor : zoomOutFactor
    });
    
    // Only proceed if scale would change
    if (Math.abs(newScale - currentScale) > 0.0001) {
      // Calculate simple proportional offsets
      const simpleOffsetX = offset.x * (newScale / currentScale);
      const simpleOffsetY = offset.y * (newScale / currentScale);
      
      // Calculate maximum valid offsets
      const maxOffsetX = Math.max(0, CANVAS_WIDTH * newScale - viewportWidth);
      const maxOffsetY = Math.max(0, CANVAS_HEIGHT * newScale - viewportHeight);
      
      // Constrain offsets to valid range
      const constrainedOffsetX = Math.max(0, Math.min(maxOffsetX, simpleOffsetX));
      const constrainedOffsetY = Math.max(0, Math.min(maxOffsetY, simpleOffsetY));
      
      // Update state
      setScale(newScale);
      setOffset({
        x: constrainedOffsetX,
        y: constrainedOffsetY
      });
      
      console.log("Force zoom state updated:", {
        newScale,
        newOffset: { 
          x: constrainedOffsetX,
          y: constrainedOffsetY
        },
        maxOffset: {
          x: maxOffsetX,
          y: maxOffsetY
        }
      });
    } else {
      console.log("Force zoom: Scale change too small, ignoring");
    }
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
        currentScale: scale,
        calculatedMinScale,
        actualMinScale: MIN_SCALE,
        viewportWidth,
        viewportHeight
      });
      
      // Actualizamos los offsets para asegurar que siguen siendo válidos
      setOffset(prev => {
        const maxOffsetX = Math.max(0, CANVAS_WIDTH * scale - viewportWidth);
        const maxOffsetY = Math.max(0, CANVAS_HEIGHT * scale - viewportHeight);
        
        return {
          x: Math.max(0, Math.min(maxOffsetX, prev.x)),
          y: Math.max(0, Math.min(maxOffsetY, prev.y))
        };
      });
    };
    
    window.addEventListener('resize', handleResize);
    
    // Initial check
    handleResize();
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [scale]);

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
      transformState: { scale, offset: { x: offset.x, y: offset.y } }
    });
    
    // SOLUCIÓN CORREGIDA:
    // 1. Calcular la posición relativa al fondo (que siempre está correctamente posicionado)
    const relativeToBackgroundX = clientX - (backgroundRect?.left || 0);
    const relativeToBackgroundY = clientY - (backgroundRect?.top || 0);
    
    // 2. Añadir el offset actual porque el canvas está desplazado
    const withOffsetX = relativeToBackgroundX + offset.x;
    const withOffsetY = relativeToBackgroundY + offset.y;
    
    // 3. Dividir por la escala para obtener las coordenadas en el espacio original del canvas
    const finalX = withOffsetX / scale;
    const finalY = withOffsetY / scale;
    
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
    ctx.save()

    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    if (currentTool === "pen") {
      ctx.globalCompositeOperation = "source-over"
      ctx.strokeStyle = "rgba(250,250,255,0.3)"
      ctx.lineWidth = 40
    } else if (currentTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out"
      ctx.strokeStyle = "rgba(0,0,0,1)"
      ctx.lineWidth = 40
    }

    ctx.beginPath()
    ctx.moveTo(fromX, fromY)
    ctx.lineTo(toX, toY)
    ctx.stroke()

    if (currentTool === "pen") {
      // Draw additional irregular strokes to simulate brush texture
      for (let i = 0; i < 3; i++) {
        const offsetX = (Math.random() - 0.5) * 4; // random offset between -2 and 2
        const offsetY = (Math.random() - 0.5) * 4;
        ctx.beginPath();
        ctx.moveTo(fromX + offsetX, fromY + offsetY);
        ctx.lineTo(toX + offsetX, toY + offsetY);
        ctx.strokeStyle = "rgba(250,240,255,0.3)";
        ctx.stroke();
      }
    } else if (currentTool === "eraser") {
      // Draw additional irregular strokes to simulate brush texture for eraser
      for (let i = 0; i < 3; i++) {
        const offsetX = (Math.random() - 0.5) * 4; // random offset between -2 and 2
        const offsetY = (Math.random() - 0.5) * 4;
        ctx.beginPath();
        ctx.moveTo(fromX + offsetX, fromY + offsetY);
        ctx.lineTo(toX + offsetX, toY + offsetY);
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.stroke();
      }
    }

    ctx.restore()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only handle mouse/pen events here, touch events are handled separately
    if (e.pointerType === 'touch') return;
    
    if (!isDrawingMode && isPanning) {
      const dx = e.movementX;
      const dy = e.movementY;
      const viewportWidth = Math.floor(backgroundRef.current?.clientWidth || window.innerWidth);
      const viewportHeight = Math.floor(backgroundRef.current?.clientHeight || window.innerHeight);
      setOffset((prev) => ({
        x: Math.max(0, Math.min(CANVAS_WIDTH * scale - viewportWidth, prev.x - dx)),
        y: Math.max(0, Math.min(CANVAS_HEIGHT * scale - viewportHeight, prev.y - dy))
      }));
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
    setIsDrawing(false)
    setIsPanning(false)
    lastPoint.current = null
    setTool(newTool)
  }

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
          backgroundSize: `${CANVAS_WIDTH * scale}px ${CANVAS_HEIGHT * scale}px`,
          backgroundPosition: `-${offset.x}px -${offset.y}px`,
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
            transform: `translate(${-offset.x}px, ${-offset.y}px) scale(${scale})`,
            transformOrigin: "0 0",
            touchAction: "none",
            width: `${CANVAS_WIDTH}px`,
            height: `${CANVAS_HEIGHT}px`,
          }}
        />
        
        {/* Zoom indicator */}
        <div className="fixed top-4 right-4 bg-black/50 text-white px-3 py-1 rounded-full font-mono text-sm z-50">
          {Math.round(scale * 100)}%
        </div>
        
        {/* Debug zoom info */}
        {zoomDebugInfo && (
          <div className="fixed bottom-4 right-4 bg-black/70 text-white p-2 rounded text-xs font-mono z-50 whitespace-pre">
            {zoomDebugInfo}
          </div>
        )}
        
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
          
          {/* Botón para mostrar/ocultar depuración visual */}
          <button 
            className="bg-black/50 text-white px-3 py-1 rounded-full text-xs"
            onClick={() => setZoomDebugInfo(zoomDebugInfo ? "" : "Touching...")}
          >
            Debug
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
    </main>
  )
}


