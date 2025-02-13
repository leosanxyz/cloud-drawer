"use client"

import { useEffect, useRef, useState } from "react"
import io from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Pencil, Eraser, Move } from "lucide-react"

const CANVAS_WIDTH = 3000
const CANVAS_HEIGHT = 2000
const VIEWPORT_WIDTH = 800
const VIEWPORT_HEIGHT = 600

type Tool = "pen" | "eraser" | "pan"

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>("pen")
  const [isDrawing, setIsDrawing] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const socketRef = useRef<any>(null)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

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
      ctx.strokeStyle = "white"
      ctx.lineWidth = 5
    } else if (currentTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out"
      ctx.strokeStyle = "rgba(0,0,0,1)"
      ctx.lineWidth = 20
    }

    ctx.beginPath()
    ctx.moveTo(fromX, fromY)
    ctx.lineTo(toX, toY)
    ctx.stroke()

    ctx.restore()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "pan" && isPanning) {
      const dx = e.movementX
      const dy = e.movementY
      setOffset((prev) => ({
        x: Math.max(0, Math.min(CANVAS_WIDTH - VIEWPORT_WIDTH, prev.x - dx)),
        y: Math.max(0, Math.min(CANVAS_HEIGHT - VIEWPORT_HEIGHT, prev.y - dy)),
      }))
      console.log("Pan movement:", { dx, dy, newOffset: offset })
      return
    }

    if (!isDrawing || tool === "pan") return

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
    }
    lastPoint.current = { x, y }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "pan") {
      setIsPanning(true)
      return
    }

    setIsDrawing(true)
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY)
    lastPoint.current = { x, y }
    console.log(`Started ${tool === "pen" ? "drawing" : "erasing"} at (${x}, ${y})`)
  }

  const handlePointerUp = () => {
    setIsDrawing(false)
    setIsPanning(false)
    lastPoint.current = null
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="flex gap-2 mb-4">
        <Button variant={tool === "pen" ? "default" : "outline"} onClick={() => setTool("pen")}>
          <Pencil className="w-4 h-4 mr-2" />
          Pen
        </Button>
        <Button variant={tool === "eraser" ? "default" : "outline"} onClick={() => setTool("eraser")}>
          <Eraser className="w-4 h-4 mr-2" />
          Eraser
        </Button>
        <Button variant={tool === "pan" ? "default" : "outline"} onClick={() => setTool("pan")}>
          <Move className="w-4 h-4 mr-2" />
          Pan
        </Button>
      </div>
      <div
        style={{
          width: `${VIEWPORT_WIDTH}px`,
          height: `${VIEWPORT_HEIGHT}px`,
          overflow: "hidden",
          border: "1px solid black",
          position: "relative",
          cursor: tool === "pan" ? "move" : "crosshair",
          backgroundImage: 'url("https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Cloudless%20Blue%20Sky%20Background-W5DbJt7OROC1E0DSpqRo71xpUJ3ePp.webp")',
          backgroundSize: `${CANVAS_WIDTH}px ${CANVAS_HEIGHT}px`,
          backgroundPosition: `-${offset.x}px -${offset.y}px`
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={{
            position: "absolute",
            transform: `translate(${-offset.x}px, ${-offset.y}px)`,
            touchAction: "none",
            width: `${CANVAS_WIDTH}px`,
            height: `${CANVAS_HEIGHT}px`,
          }}
        />
      </div>
    </main>
  )
}

