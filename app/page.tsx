"use client"

import { useEffect, useRef, useState } from "react"
import io from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Pencil, Eraser, Move, Check } from "lucide-react"

const CANVAS_WIDTH = 3000
const CANVAS_HEIGHT = 2000
const VIEWPORT_WIDTH = 800
const VIEWPORT_HEIGHT = 600

type Tool = "pen" | "eraser" | "pan"

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offset, setOffset] = useState({ 
    x: (CANVAS_WIDTH - VIEWPORT_WIDTH) / 2, 
    y: (CANVAS_HEIGHT - VIEWPORT_HEIGHT) / 2 
  })
  const [tool, setTool] = useState<Tool>("pan")
  const [isDrawing, setIsDrawing] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const socketRef = useRef<any>(null)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const strokeBoundsRef = useRef<{minX: number, minY: number, maxX: number, maxY: number} | null>(null)
  const isDrawingMode = tool === "pen" || tool === "eraser"
  const containerRef = useRef<HTMLDivElement>(null)
  const backgroundRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Set canvas size
    canvas.width = CANVAS_WIDTH
    canvas.height = CANVAS_HEIGHT

    // Connect to WebSocket server with configuration for Vercel
    socketRef.current = io(process.env.NEXT_PUBLIC_SOCKET_URL || '', {
      transports: ['polling', 'websocket'],
      path: '/api/socket'
    })

    // Solicitar el estado actual del canvas al conectarse
    socketRef.current.emit('requestCanvasState')

    // Escuchar el estado inicial del canvas
    socketRef.current.on('canvasState', (imageData: string) => {
      const img = new Image()
      img.onload = () => {
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

  const getCanvasCoordinates = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    // Primero ajustamos por el offset visual del canvas
    const rawX = clientX - rect.left
    const rawY = clientY - rect.top

    // Luego escalamos al tamaño real del canvas
    const finalX = rawX * scaleX
    const finalY = rawY * scaleY

    console.log({
      mouseX: clientX,
      mouseY: clientY,
      canvasLeft: rect.left,
      canvasTop: rect.top,
      rawX,
      rawY,
      scaleX,
      scaleY,
      offset: offset.x,
      finalX,
      finalY
    })

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
    console.log(`Drawing from (${fromX}, ${fromY}) to (${toX}, ${toY}) with offset: ${offset.x}, ${offset.y}`)
    
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
    if (!isDrawingMode && isPanning) {
      const dx = e.movementX;
      const dy = e.movementY;
      const viewportWidth = Math.floor(backgroundRef.current?.clientWidth || window.innerWidth);
      const viewportHeight = Math.floor(backgroundRef.current?.clientHeight || window.innerHeight);
      setOffset((prev) => ({
        x: Math.max(0, Math.min(CANVAS_WIDTH - viewportWidth, prev.x - dx)),
        y: Math.max(0, Math.min(CANVAS_HEIGHT - viewportHeight, prev.y - dy))
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
        strokeBoundsRef.current.minX = Math.min(strokeBoundsRef.current.minX, x);
        strokeBoundsRef.current.minY = Math.min(strokeBoundsRef.current.minY, y);
        strokeBoundsRef.current.maxX = Math.max(strokeBoundsRef.current.maxX, x);
        strokeBoundsRef.current.maxY = Math.max(strokeBoundsRef.current.maxY, y);
      }
    }
    lastPoint.current = { x, y }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingMode) {
      setIsPanning(true)
      return
    }

    setIsDrawing(true)
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY)
    lastPoint.current = { x, y }
    strokeBoundsRef.current = { minX: x, minY: y, maxX: x, maxY: y }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDrawing(false)
    setIsPanning(false)
    lastPoint.current = null
  }

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  const handleAccept = () => {
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
          ctx.save()
          ctx.font = "20px sans-serif"
          ctx.fillStyle = "white"
          ctx.textAlign = "center"
          const textX = (strokeBoundsRef.current.minX + strokeBoundsRef.current.maxX) / 2
          const textY = strokeBoundsRef.current.maxY + 40
          ctx.fillText(formattedDateTime, textX, textY)
          ctx.restore()

          // Guardar el estado del canvas en el servidor
          const imageData = canvas.toDataURL('image/png')
          socketRef.current.emit('saveCanvasState', imageData)
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
          backgroundSize: `${CANVAS_WIDTH}px ${CANVAS_HEIGHT}px`,
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
            transform: `translate(${-offset.x}px, ${-offset.y}px)`,
            touchAction: "none",
            width: `${CANVAS_WIDTH}px`,
            height: `${CANVAS_HEIGHT}px`,
          }}
        />
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


