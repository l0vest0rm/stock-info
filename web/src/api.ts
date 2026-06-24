export function convertResponse(response: Response, accept: string): Promise<unknown> {
  const contentType = response.headers.get('Content-Type')?.split(';')[0]
  switch (contentType) {
    case 'application/json':
      return response.json()
    case 'text/plain':
      if (accept === 'json') {
        return response.text().then((text) => {
          try {
            return JSON.parse(text)
          } catch {
            return text
          }
        })
      }
      return response.text()
    case 'text/javascript':
      return response.text()
    default:
      return response.text()
  }
}

export function parseResponseData(data: unknown, accept: string): unknown {
  if (typeof data === 'string') {
    let begin = 0
    let end = data.length
    if (data.startsWith('jQuery')) {
      begin = data.indexOf('(')
      end = data.lastIndexOf(')')
      try {
        return JSON.parse(data.substring(begin + 1, end))
      } catch {
        return data
      }
    }
    if (accept === 'json') {
      begin = data.indexOf('=')
      if (begin > 0) {
        try {
          return JSON.parse(data.substring(begin + 1, data.length - 1))
        } catch {
          return data
        }
      }
      try {
        return JSON.parse(data)
      } catch {
        return data
      }
    }
  }

  return data
}
