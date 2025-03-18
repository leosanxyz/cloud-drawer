import { Server } from 'socket.io'
import { supabase } from '../lib/supabaseClient'

// Eliminamos la variable canvasState ya que ahora usaremos Supabase
export default function socketHandler(io: Server) {
  io.on('connection', async (socket) => {
    // Cuando un cliente solicita el estado del canvas
    socket.on('requestCanvasState', async () => {
      try {
        console.log('Fetching canvas state...')
        const { data, error } = await supabase
          .from('canvas_states')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
        
        if (error) {
          console.error('Error fetching state:', error)
          throw error
        }
        
        if (data && data.length > 0) {
          const currentState = data[0];
          console.log('Sending canvas state to client with ID:', currentState.id)
          
          // Verificar si hay nota y coordenadas
          const hasNoteData = currentState.note_x && currentState.note_y;
          console.log('Has note data:', hasNoteData, 'Note text:', currentState.note_text);
          
          // Enviar el estado completo incluyendo la nota y la posición del punto
          socket.emit('canvasState', {
            imageData: currentState.state,
            id: currentState.id,
            noteText: currentState.note_text || '',
            notePoint: currentState.note_x && currentState.note_y 
              ? { x: currentState.note_x, y: currentState.note_y } 
              : null,
            drawingBounds: currentState.drawing_bounds 
              ? JSON.parse(currentState.drawing_bounds) 
              : null
          })
        } else {
          console.log('No saved state found')
          socket.emit('canvasState', { imageData: '' })
        }
      } catch (error) {
        console.error('Error fetching canvas state:', error)
        socket.emit('canvasState', { imageData: '' })
      }
    })

    // Cuando un cliente guarda un nuevo estado
    socket.on('saveCanvasState', async (data: any) => {
      try {
        console.log('Saving new canvas state...')
        
        // Verificar si tenemos los datos necesarios
        if (!data || !data.imageData) {
          console.error('Missing data in saveCanvasState')
          return
        }
        
        // Extraer los datos
        const { imageData, notePoint, drawingBounds, noteText, id } = data
        
        // Preparar el objeto para insertar
        const insertObj: any = {
          state: imageData,
          created_at: new Date().toISOString(),
          note_text: noteText || ''
        }
        
        // Añadir coordenadas del punto de nota si existen
        if (notePoint) {
          console.log('Adding note point to insert object:', notePoint)
          insertObj.note_x = notePoint.x
          insertObj.note_y = notePoint.y
        }
        
        // Añadir límites del dibujo si existen
        if (drawingBounds) {
          console.log('Adding drawing bounds to insert object')
          insertObj.drawing_bounds = JSON.stringify(drawingBounds)
        }
        
        console.log('Final insert object:', JSON.stringify(insertObj));
        
        // Insertar y obtener el resultado para tener el ID
        const { data: insertedData, error } = await supabase
          .from('canvas_states')
          .insert([insertObj])
          .select()
        
        if (error) {
          console.error('Error saving state:', error)
          throw error
        }
        
        console.log('Successfully inserted canvas state:', insertedData?.[0]?.id || 'no ID')
        
        // Emitir a todos los clientes excepto al que envió
        socket.broadcast.emit('canvasState', {
          id: insertedData?.[0]?.id,
          imageData,
          notePoint,
          noteText: insertObj.note_text,
          drawingBounds
        })
        
        // También confirmar al cliente que envió para que actualice su ID
        socket.emit('saveConfirmed', {
          success: true,
          id: insertedData?.[0]?.id
        })
      } catch (error) {
        console.error('Error saving canvas state:', error)
        socket.emit('saveConfirmed', { success: false, error: 'Failed to save canvas state' })
      }
    })
    
    // Nuevo evento para actualizar el texto de la nota
    socket.on('updateNoteText', async (data: any) => {
      try {
        console.log('Received updateNoteText event with data:', data);
        
        if (!data || !data.id) {
          console.error('Missing ID in updateNoteText:', data)
          socket.emit('noteUpdateConfirmed', { success: false, error: 'Missing ID' })
          return
        }
        
        // Asegurarse de que noteText sea al menos una cadena vacía si es null o undefined
        const noteText = data.noteText || '';
        
        console.log('Updating note text for id:', data.id, 'with text:', noteText)
        
        // Actualizar la nota en la base de datos
        const { data: updateData, error } = await supabase
          .from('canvas_states')
          .update({ note_text: noteText })
          .eq('id', data.id)
          .select()
        
        if (error) {
          console.error('Error updating note text in Supabase:', error)
          socket.emit('noteUpdateConfirmed', { success: false, error: 'Database error' })
          throw error
        }
        
        console.log('Note text updated successfully, response:', updateData?.[0]?.note_text || 'no text')
        
        // Emitir a todos los clientes excepto al que envió
        socket.broadcast.emit('noteUpdated', {
          id: data.id,
          noteText: noteText,
          notePoint: data.notePoint
        })
        
        // Responder al cliente que envió el evento para confirmar
        socket.emit('noteUpdateConfirmed', {
          success: true,
          id: data.id,
          noteText: noteText
        })
      } catch (error) {
        console.error('Error in updateNoteText handler:', error)
        
        // Notificar al cliente sobre el error
        socket.emit('noteUpdateConfirmed', {
          success: false,
          error: 'Failed to update note text'
        })
      }
    })

    // Manejar los eventos de dibujo existentes
    socket.on('draw', (data) => {
      socket.broadcast.emit('draw', data)
    })
  })
} 